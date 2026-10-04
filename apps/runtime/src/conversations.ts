import { MAIN_THREAD, type ThreadView } from '@purrable/contracts'
import { asc, eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { PiHarness } from 'agents/harness/pi'
import { InvalidInput, NotFound } from './http/errors.ts'
import { BACKGROUND, entryId } from './pi/context.ts'
import { appConversations } from './storage/schema.ts'

type Row = typeof appConversations.$inferSelect
export type ThreadChange = { readonly title?: string | undefined; readonly archived?: boolean | undefined }

/** Entries a thread may branch from: something the owner or the agent said, never a tool or system record. */
const BRANCHABLE = new Set(['pi.user', 'pi.assistant'])

/**
 * The agent's conversations the owner can reach. Pi owns every transcript; this registry is what Pi does not keep
 * (kind, title, origin, archived) and the gate in front of Pi: a session id reaches Pi only if it is registered here,
 * so no request can open a conversation by guessing its number.
 */
export class ConversationRegistry {
  readonly #db: DrizzleSqliteDODatabase
  readonly #harness: PiHarness

  constructor(db: DrizzleSqliteDODatabase, harness: PiHarness, now: number) {
    this.#db = db
    this.#harness = harness
    db.insert(appConversations)
      .values({ sessionId: MAIN_THREAD, kind: 'main', createdAt: now })
      .onConflictDoNothing()
      .run()
  }

  #row(id: string): Row | undefined {
    return this.#db.select().from(appConversations).where(eq(appConversations.sessionId, id)).get()
  }

  /** The Pi session of a registered conversation; anything else is `NotFound`. */
  require(id: string): string {
    if (this.#row(id) === undefined) throw new NotFound({ what: 'thread' })
    return id
  }

  /** Every registered conversation, oldest first (main is the oldest), with whether Pi is running it now. */
  async list(): Promise<readonly ThreadView[]> {
    const rows = this.#db.select().from(appConversations).orderBy(asc(appConversations.createdAt)).all()
    return Promise.all(rows.map(async (row) => this.#view(row, await this.#harness.session(row.sessionId).busy())))
  }

  /**
   * A thread that sees main as it was at `entry` (a message in main) and continues on its own; main never sees it.
   * Pi forks by reference, so nothing is copied.
   */
  async branch(entry: number, now: number): Promise<ThreadView> {
    const main = await (await this.#harness.pi()).conversation(ROOT_CONVERSATION_ID, BACKGROUND)
    if (main === undefined) throw new NotFound({ what: 'thread' })
    const id = entryId(entry)
    const [at] = (await main.entries({ minEntryId: id, maxEntryId: id }, 1, undefined, BACKGROUND)).items
    if (at === undefined || !BRANCHABLE.has(at.kind)) throw new InvalidInput({ reason: 'branch_entry' })
    const fork = await main.fork(at.id, { ownership: { kind: 'ownerless' } }, BACKGROUND)
    return this.#insert(
      { sessionId: String(fork.id), kind: 'thread', parentSession: MAIN_THREAD, forkEntry: at.id },
      now,
    )
  }

  /** An empty thread. */
  async create(now: number): Promise<ThreadView> {
    const session = await this.#harness.sessions.create()
    return this.#insert({ sessionId: session.id, kind: 'thread', parentSession: MAIN_THREAD }, now)
  }

  /** Rename or (un)archive a thread or subagent; main keeps its name and is never archived. */
  async update(id: string, change: ThreadChange, now: number): Promise<ThreadView> {
    const row = this.#row(this.require(id))
    if (row?.kind === 'main') throw new InvalidInput({ reason: 'main_thread' })
    this.#db
      .update(appConversations)
      .set({
        ...(change.title === undefined ? {} : { title: change.title }),
        ...(change.archived === undefined ? {} : { archivedAt: change.archived ? now : null }),
      })
      .where(eq(appConversations.sessionId, id))
      .run()
    return this.#reload(id)
  }

  async #insert(values: Omit<typeof appConversations.$inferInsert, 'createdAt'>, now: number): Promise<ThreadView> {
    this.#db
      .insert(appConversations)
      .values({ ...values, createdAt: now })
      .run()
    return this.#reload(values.sessionId)
  }

  async #reload(id: string): Promise<ThreadView> {
    const row = this.#row(id)
    if (row === undefined) throw new NotFound({ what: 'thread' })
    return this.#view(row, await this.#harness.session(id).busy())
  }

  #view(row: Row, busy: boolean): ThreadView {
    return {
      id: row.sessionId,
      kind: row.kind,
      ...(row.title === null ? {} : { title: row.title }),
      ...(row.parentSession === null ? {} : { parent: row.parentSession }),
      busy,
      archived: row.archivedAt !== null,
      createdAt: row.createdAt,
    }
  }
}
