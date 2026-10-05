import { asc, eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { PiHarness } from 'agents/harness/pi'
import { UsageDoc, type CommitChange } from '@earendil-works/pi-durable'
import type { MemberAccess } from './access.ts'
import type { MemberUsage } from './usage.ts'
import { appConversations } from '../storage/schema.ts'
import { BACKGROUND, conversationId } from '../pi/context.ts'
import { authoredContent } from '../pi/content.ts'
import { textBlocks } from '../pi/transcript.ts'

export const memberJournal = sqliteTable('app_member_journal', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  key: text('source_key').notNull().unique(),
  session: text('session_id').notNull(),
  user: text('user_id').notNull(),
  kind: text('kind', { enum: ['usage', 'exchange', 'decision'] }).notNull(),
  body: text('body').notNull(),
  at: integer('committed_at').notNull(),
  done: integer('done').notNull().default(0),
})
type Row = typeof memberJournal.$inferInsert

/** App-only outbox: synchronous committed-event capture, timestamped usage, idempotent passive Pi projection. */
export class MemberJournal {
  #pending: Promise<void> = Promise.resolve()
  constructor(
    readonly db: DrizzleSqliteDODatabase,
    readonly harness: PiHarness,
    readonly usage: MemberUsage,
  ) {}
  capture(row: Row): void {
    this.db.insert(memberJournal).values(row).onConflictDoNothing().run()
    void this.flush().catch(() => undefined)
  }
  async flush(): Promise<void> {
    this.#pending = this.#pending.catch(() => undefined).then(() => this.#drain())
    await this.#pending
  }
  async #drain(): Promise<void> {
    for (const row of this.db
      .select()
      .from(memberJournal)
      .where(eq(memberJournal.done, 0))
      .orderBy(asc(memberJournal.id))
      .all()) {
      if (row.kind === 'usage') await this.usage.project(row.user, row.session, JSON.parse(row.body), row.at)
      else if (row.kind === 'decision') {
        const context = await (await this.harness.pi()).conversation(conversationId(row.session), BACKGROUND)
        if (context === undefined) throw new Error('Missing interaction conversation')
        await context.submit(
          {
            type: 'write',
            requestId: row.key,
            entry: {
              kind: 'app.member_decision',
              data: JSON.parse(row.body),
              model: [
                {
                  role: 'user',
                  content: JSON.stringify({ trust: 'quoted', receipt: JSON.parse(row.body) }),
                  timestamp: row.at,
                },
              ],
            },
          },
          BACKGROUND,
        )
      } else {
        const root = await (await this.harness.pi()).conversation(conversationId('1'), BACKGROUND)
        if (root === undefined) throw new Error('Missing root conversation')
        await root.submit(
          {
            type: 'write',
            requestId: row.key,
            entry: {
              kind: 'app.member_exchange',
              data: { session: row.session, userId: row.user, trust: 'quoted' },
              model: [{ role: 'user', content: authoredContent(`member ${row.user}`, row.body), timestamp: row.at }],
            },
          },
          BACKGROUND,
        )
      }
      this.db.update(memberJournal).set({ done: 1 }).where(eq(memberJournal.id, row.id)).run()
    }
  }
  async ready(): Promise<void> {
    await this.flush()
  }
  #committed(change: CommitChange, seq: string, access: MemberAccess): void {
    const id =
      change.type === 'entry'
        ? change.value.conversationId
        : change.type === 'document'
          ? change.conversationId
          : undefined
    if (id === undefined) return
    const session = String(id)
    let origin: ReturnType<MemberAccess['origin']>
    try {
      origin = access.origin(session)
    } catch {
      return
    }
    if (origin?.principalUserId === null || origin === undefined) return
    if (change.type === 'document' && change.record.kind === 'pi.usage' && change.value !== null)
      this.capture({
        key: `usage:${seq}:${session}`,
        session,
        user: origin.principalUserId,
        kind: 'usage',
        body: JSON.stringify(change.value),
        at: Date.now(),
      })
    if (
      change.type === 'entry' &&
      change.value.kind === 'pi.assistant' &&
      origin.memberPurpose === 'main' &&
      origin.sessionId === session
    ) {
      const body = (change.value.model ?? [])
        .flatMap((m) => (m.role === 'assistant' ? textBlocks(m.content) : []))
        .join('\n')
      if (body !== '')
        this.capture({
          key: `member:answer:${change.value.id}`,
          session,
          user: origin.principalUserId,
          kind: 'exchange',
          body,
          at: Date.now(),
        })
    }
  }
  async install(access: MemberAccess): Promise<void> {
    const pi = await this.harness.pi()
    await this.flush()
    const off = pi.subscribeCommits((publication) => {
      for (const change of publication.changes) this.#committed(change, String(publication.seq), access)
    })
    pi.subscribeClose(off)
    for (const row of this.db.select().from(appConversations).all()) {
      const origin = access.origin(row.sessionId)
      if (origin?.principalUserId === null || origin === undefined) continue
      const value = await pi.snapshot(UsageDoc, conversationId(row.sessionId), BACKGROUND)
      if (value !== undefined) await this.usage.project(origin.principalUserId, row.sessionId, value, Date.now())
    }
  }
}
