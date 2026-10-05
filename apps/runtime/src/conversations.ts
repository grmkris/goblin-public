import { MAIN_THREAD, type ThreadPreview, type ThreadPreviewMessage, type ThreadView } from '@purrable/contracts'
import { and, asc, eq, isNull } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import type { Conversation, EntryRecord, Extension } from '@earendil-works/pi-durable'
import type { PiHarness } from 'agents/harness/pi'
import type { CapabilityProfiles } from './capabilities/profiles.ts'
import { InvalidInput, NotFound } from './http/errors.ts'
import type { MainMemory } from './memory/memory.ts'
import type { CheapModel } from './memory/model.ts'
import { authoredContent, threadStartedContent } from './pi/content.ts'
import { BACKGROUND, conversationId, entryId } from './pi/context.ts'
import { recentMessages } from './pi/transcript.ts'
import { firstThreadMessages } from './thread-preview.ts'
import { ReplyLedger } from './replies.ts'
import { appConversations } from './storage/schema.ts'

type Row = typeof appConversations.$inferSelect
export type ThreadChange = { readonly title?: string | undefined; readonly archived?: boolean | undefined }

/** Entries in one page of a conversation's history. */
const HISTORY_PAGE = 40

/** Entries a thread may branch from: something the owner or the agent said, never a tool or system record. */
const BRANCHABLE = new Set(['pi.user', 'pi.assistant'])

const TITLE_SYSTEM =
  'You name conversations. Reply with only a title of two to five words for the exchange you are given: no quotes, no ending punctuation.'

/** The first line of a model's title, without quotes, at most 60 characters; empty when there is none. */
const cleanTitle = (raw: string): string =>
  (raw.split('\n')[0] ?? '')
    .replaceAll(/["'`*]/gu, '')
    .trim()
    .slice(0, 60)

/**
 * What threads need beyond the registry: their own extension, `recall` for the ones branched from main (they start
 * with main's memory view), the memory that bounds their zooms, the cheap model that names them, and the switches a
 * new thread copies from main.
 */
export type ThreadKit = {
  readonly thread: Extension
  readonly recall: Extension
  readonly memory: MainMemory
  readonly namer: CheapModel
  readonly capabilities: CapabilityProfiles
}

/**
 * The agent's conversations the owner can reach. Pi owns every transcript; this registry is what Pi does not keep
 * (kind, title, origin, archived) and the gate in front of Pi: a session id reaches Pi only if it is registered here,
 * so no request can open a conversation by guessing its number.
 */
export class ConversationRegistry {
  readonly #db: DrizzleSqliteDODatabase
  readonly #harness: PiHarness
  readonly #kit: ThreadKit
  readonly #naming = new Set<string>()
  readonly #replies = new ReplyLedger()
  readonly #previews = new Map<string, readonly ThreadPreviewMessage[]>()

  constructor(db: DrizzleSqliteDODatabase, harness: PiHarness, kit: ThreadKit, now: number) {
    this.#db = db
    this.#harness = harness
    this.#kit = kit
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

  /** Whether a registered conversation is main, a thread or a subagent; anything else is `NotFound`. */
  kindOf(id: string): Row['kind'] {
    const row = this.#row(id)
    if (row === undefined) throw new NotFound({ what: 'thread' })
    return row.kind
  }

  /**
   * Every registered conversation, oldest first (main is the oldest), with whether Pi is running it now and, for a
   * live thread, its own activity.
   */
  async list(): Promise<readonly ThreadView[]> {
    const rows = this.#db.select().from(appConversations).orderBy(asc(appConversations.createdAt)).all()
    return Promise.all(rows.map(async (row) => this.#describe(row)))
  }

  /**
   * A thread that sees main as it was at `entry` (a message in main) and continues on its own; main never sees it.
   * Pi forks by reference, so nothing is copied.
   */
  async branch(entry: number, now: number): Promise<ThreadView> {
    const main = await this.#conversation(MAIN_THREAD)
    const id = entryId(entry)
    const [at] = (await main.entries({ minEntryId: id, maxEntryId: id }, 1, undefined, BACKGROUND)).items
    if (at === undefined || !BRANCHABLE.has(at.kind)) throw new InvalidInput({ reason: 'branch_entry' })
    const extensions = { add: [this.#kit.thread, this.#kit.recall] }
    // The fork starts from main's agent as it was at that entry; its tool filter is set to main's switches now.
    const agent = { extensions, tools: this.#kit.capabilities.piTools(MAIN_THREAD) }
    const fork = await main.fork(at.id, { ownership: { kind: 'ownerless' }, agent }, BACKGROUND)
    const recallThrough = this.#kit.memory.sizeAt(at.id)
    return this.#insert(
      { sessionId: String(fork.id), kind: 'thread', parentSession: MAIN_THREAD, forkEntry: at.id, recallThrough },
      now,
    )
  }

  /** An empty thread the owner started; main learns its name once it has one (`announce`). */
  async create(now: number): Promise<ThreadView> {
    const session = await this.#harness.sessions.create()
    const tools = this.#kit.capabilities.piTools(MAIN_THREAD)
    await (
      await this.#conversation(session.id)
    ).configure({ extensions: { add: [this.#kit.thread] }, tools }, BACKGROUND)
    return this.#insert({ sessionId: session.id, kind: 'thread', parentSession: MAIN_THREAD, mainNote: 'owed' }, now)
  }

  /** How far `zoom` reaches into main's memory from `session`: all of it from main, up to its fork from a thread. */
  recallLimit(session: string, mainSize: number): number {
    const row = this.#row(session)
    return row?.kind === 'main' ? mainSize : (row?.recallThrough ?? 0)
  }

  /** Registers a subagent's conversation under the one that started it; a reporter repeats it, so it is idempotent. */
  registerSubagent(session: string, parent: string, name: string, now: number): void {
    this.#db
      .insert(appConversations)
      .values({ sessionId: session, kind: 'subagent', title: name, parentSession: parent, createdAt: now })
      .onConflictDoNothing()
      .run()
  }

  /** How many subagents are working now, across every conversation. */
  async runningSubagents(): Promise<number> {
    const rows = this.#db.select().from(appConversations).where(eq(appConversations.kind, 'subagent')).all()
    const busy = await Promise.all(rows.map(async (row) => this.#harness.session(row.sessionId).busy()))
    return busy.filter(Boolean).length
  }

  /**
   * A note from a thread into main: main's model sees it, labelled with the thread, and no run starts. It goes in as
   * a write submission (never a direct append), so a busy main places it at its next boundary.
   */
  async shareToMain(thread: string, note: string, requestId: string): Promise<void> {
    const row = this.#row(thread)
    if (row === undefined || row.kind === 'main') throw new InvalidInput({ reason: 'share_from_main' })
    // A thread shared from before its title is written is labelled as untitled, never with a made-up name.
    const content = authoredContent(row.title === null ? 'thread (untitled)' : `thread "${row.title}"`, note)
    await (
      await this.#conversation(MAIN_THREAD)
    ).submit(
      {
        type: 'write',
        requestId,
        entry: { kind: 'app.shared', data: { thread }, model: [{ role: 'user', content, timestamp: Date.now() }] },
      },
      BACKGROUND,
    )
  }

  /**
   * Tells main, once, about a thread the owner started with "+": when it has a title (the cheap model's or the
   * owner's), main gets a note naming it, which its model sees and which starts no run. Nothing said in the thread goes
   * with it, and a later rename does not rewrite it. The write's request id makes a retry after a crash the same note.
   */
  async announce(thread: string): Promise<void> {
    const row = this.#row(thread)
    if (row?.kind !== 'thread' || row.mainNote !== 'owed' || row.title === null) return
    const model = [{ role: 'user' as const, content: threadStartedContent(row.title), timestamp: Date.now() }]
    await (
      await this.#conversation(MAIN_THREAD)
    ).submit(
      {
        type: 'write',
        requestId: `thread-started:${thread}`,
        entry: { kind: 'app.thread_started', data: { thread }, model },
      },
      BACKGROUND,
    )
    this.#db
      .update(appConversations)
      .set({ mainNote: 'written' })
      .where(and(eq(appConversations.sessionId, thread), eq(appConversations.mainNote, 'owed')))
      .run()
  }

  /** Names an untitled thread from its latest exchange with the cheap model; once at a time per thread. */
  async nameIfUntitled(thread: string): Promise<void> {
    const row = this.#row(thread)
    if (row?.kind !== 'thread' || row.title !== null || this.#naming.has(thread)) return
    this.#naming.add(thread)
    try {
      const [question, answer] = await recentMessages(await this.#conversation(thread), 2)
      if (question?.role !== 'user' || answer?.role !== 'assistant') return
      const exchange = `Owner: ${question.text.slice(0, 800)}\nAgent: ${answer.text.slice(0, 800)}`
      const title = cleanTitle(await this.#kit.namer.complete(TITLE_SYSTEM, exchange, 24))
      if (title === '') return
      this.#db
        .update(appConversations)
        .set({ title })
        .where(and(eq(appConversations.sessionId, thread), isNull(appConversations.title)))
        .run()
    } finally {
      this.#naming.delete(thread)
    }
  }

  /**
   * A page of a conversation's history before entry `before`, oldest first: what the model no longer sees once a memory
   * view or a compaction starts its context later, but the people in the conversation still read.
   */
  async history(
    session: string,
    before: number,
  ): Promise<{ readonly entries: readonly EntryRecord[]; readonly more: boolean }> {
    const page = await (
      await this.#conversation(this.require(session))
    ).entries({ maxEntryId: entryId(before - 1) }, HISTORY_PAGE, undefined, BACKGROUND)
    return { entries: page.items.toReversed(), more: page.next !== undefined }
  }

  /** A compact read of a registered thread; completed first-five previews stay stable in this isolate. */
  async preview(session: string): Promise<ThreadPreview> {
    const row = this.#row(this.require(session))
    if (row === undefined || row.kind !== 'thread') throw new NotFound({ what: 'thread' })
    const view = await this.#describe(row)
    const messages =
      this.#previews.get(session) ?? (await firstThreadMessages(await this.#conversation(session), row.forkEntry ?? 0))
    if (messages.length === 5) this.#previews.set(session, messages)
    const shownReplies = messages.filter((message) => message.text !== '').length
    return { threadId: session, messages, more: Math.max(0, (view.replies ?? 0) - shownReplies), busy: view.busy }
  }

  async #conversation(session: string): Promise<Conversation> {
    const conversation = await (await this.#harness.pi()).conversation(conversationId(session), BACKGROUND)
    if (conversation === undefined) throw new NotFound({ what: 'thread' })
    return conversation
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

  /** Registers a new thread with main's switches, copied in the same synchronous step (no await between). */
  async #insert(values: Omit<typeof appConversations.$inferInsert, 'createdAt'>, now: number): Promise<ThreadView> {
    this.#db
      .insert(appConversations)
      .values({ ...values, createdAt: now })
      .run()
    this.#kit.capabilities.copy(MAIN_THREAD, values.sessionId, now)
    return this.#reload(values.sessionId)
  }

  async #reload(id: string): Promise<ThreadView> {
    const row = this.#row(id)
    if (row === undefined) throw new NotFound({ what: 'thread' })
    return this.#describe(row)
  }

  async #describe(row: Row): Promise<ThreadView> {
    const busy = await this.#harness.session(row.sessionId).busy()
    const view: ThreadView = {
      id: row.sessionId,
      kind: row.kind,
      ...(row.title === null ? {} : { title: row.title }),
      ...(row.parentSession === null ? {} : { parent: row.parentSession }),
      busy,
      archived: row.archivedAt !== null,
      createdAt: row.createdAt,
    }
    if (row.kind !== 'thread' || row.archivedAt !== null) return view
    const floor = row.forkEntry ?? 0
    const activity = await this.#replies.stats(row.sessionId, await this.#conversation(row.sessionId), floor)
    return { ...view, ...(row.forkEntry === null ? {} : { forkEntry: row.forkEntry }), ...activity }
  }
}
