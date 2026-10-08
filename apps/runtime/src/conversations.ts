import { type ConversationView, type HelperExclusion, MAIN_THREAD, type UpdateConversation } from '@goblin/contracts'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import type { Conversation, EntryRecord, Extension } from '@earendil-works/pi-durable'
import type { PiHarness } from 'agents/harness/pi'
import type { CapabilityProfiles } from './capabilities/profiles.ts'
import { writeHelperExclusions } from './capabilities/profiles.ts'
import type { ChatDirectory } from './chats/directory.ts'
import { InvalidInput, NotFound } from './http/errors.ts'
import type { MainMemory } from './memory/memory.ts'
import type { CheapModel } from './memory/model.ts'
import { authoredContent, threadStartedContent } from './pi/content.ts'
import { BACKGROUND, conversationId, entryId } from './pi/context.ts'
import { answerText, dropRelaysTo, Subagents } from './pi/subagent-relay.ts'
import { type ReplyStats, recentMessages } from './pi/transcript.ts'
import { ReplyLedger } from './replies.ts'
import { appConversations } from './storage/schema.ts'

type Row = typeof appConversations.$inferSelect

/** What an update did: the conversation as it is now, and every conversation a Close closed (it and those below). */
export type Updated = { readonly view: ConversationView; readonly closed: readonly string[] }

/**
 * `tree`: `id` and every conversation under it, as a recursive CTE. `UNION` drops repeats, so even a cycle in stored
 * parents would end.
 */
const tree = (id: string) =>
  sql`WITH RECURSIVE tree(id) AS (
        SELECT ${id}
        UNION
        SELECT conversation.session_id FROM app_conversations AS conversation
        JOIN tree ON conversation.parent_session = tree.id
      )`

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

/** How a conversation is named in a note it leaves elsewhere: an untitled one says so, never a made-up name. */
const labelOf = (row: Row): string => (row.title === null ? `${row.kind} (untitled)` : `${row.kind} "${row.title}"`)

/**
 * What threads need beyond the registry: their own extension, `recall` for the ones that see main's history (they
 * start with main's memory view), the memory that bounds their zooms, the cheap model that names them, and the switches
 * a new thread copies from the conversation it came from.
 */
export type ThreadKit = {
  readonly thread: Extension
  readonly recall: Extension
  readonly memory: MainMemory
  readonly namer: CheapModel
  readonly capabilities: CapabilityProfiles
  readonly chats: ChatDirectory
}

/**
 * The agent's conversations the owner can reach, as a tree: main at the root, each thread under the conversation it
 * branched from (main for one started empty), each subagent under its spawner. Pi owns every transcript; this registry
 * is what Pi does not keep (kind, title, origin, closed) and the gate in front of Pi: a chat id resolves to its current Pi session only if it
 * is registered here, so no request can open a conversation by guessing its number.
 */
export class ConversationRegistry {
  readonly #db: DrizzleSqliteDODatabase
  readonly #harness: PiHarness
  readonly #kit: ThreadKit
  readonly #naming = new Set<string>()
  readonly #replies = new ReplyLedger()
  readonly #listeners = new Set<(ids: readonly string[]) => void>()

  constructor(db: DrizzleSqliteDODatabase, harness: PiHarness, kit: ThreadKit, now: number) {
    this.#db = db
    this.#harness = harness
    this.#kit = kit
    db.insert(appConversations)
      .values({ chatId: MAIN_THREAD, piSession: MAIN_THREAD, role: 'primary', kind: 'main', createdAt: now })
      .onConflictDoNothing()
      .run()
    kit.chats.onRebind((chat) => this.#changed([chat]))
  }

  /** Calls `listener` after each write with the conversations it changed; returns what unsubscribes it. */
  onChange(listener: (ids: readonly string[]) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #changed(ids: readonly string[]): void {
    if (ids.length > 0) for (const listener of this.#listeners) listener(ids)
  }

  #row(id: string): Row | undefined {
    return this.#db.select().from(appConversations).where(eq(appConversations.chatId, id)).get()
  }

  /** A registered conversation's row; anything else is `NotFound`. */
  #registered(id: string): Row {
    const row = this.#row(id)
    if (row === undefined) throw new NotFound({ what: 'conversation' })
    return row
  }

  /** The Pi session of a registered conversation; anything else is `NotFound`. */
  require(id: string): string {
    this.#registered(id)
    return this.#kit.chats.session(id)
  }

  /** The Pi session of a registered conversation that is open: a closed one is read, never written to. */
  requireOpen(id: string): string {
    const row = this.#registered(id)
    if (row.closedAt !== null) throw new InvalidInput({ reason: 'conversation_closed' })
    return this.#kit.chats.session(id)
  }

  /** Whether a registered conversation is main, a thread or a subagent; anything else is `NotFound`. */
  kindOf(id: string): Row['kind'] {
    return this.#registered(id).kind
  }

  /** One registered conversation as the owner sees it; `undefined` when it is not registered. */
  async view(id: string): Promise<ConversationView | undefined> {
    const row = this.#row(id)
    return row === undefined ? undefined : this.#describe(row)
  }

  /** Every registered conversation, oldest first (main is the oldest), closed ones included. */
  async list(): Promise<readonly ConversationView[]> {
    const rows = this.#db.select().from(appConversations).orderBy(asc(appConversations.createdAt)).all()
    return Promise.all(rows.map(async (row) => this.#describe(row)))
  }

  /** Latest report the parent received, bounded and labelled as reference data by the composer. */
  async helperReference(id: string) {
    const row = this.#registered(id)
    if (row.kind !== 'subagent' || row.parentSession === null) throw new NotFound({ what: 'subagent' })
    const pi = await this.#harness.pi()
    const roster = await pi.snapshot(
      Subagents,
      conversationId(row.spawnerSession ?? this.require(row.parentSession)),
      BACKGROUND,
    )
    const helper = Object.values(roster?.agents ?? {}).find((agent) => String(agent.conversationId) === id)
    const at = helper?.reported.at(-1)
    const conversation = await this.#conversation(id)
    const entries =
      at === undefined
        ? []
        : (await conversation.entries({ minEntryId: at, maxEntryId: at }, 1, undefined, BACKGROUND)).items
    const busy = await this.#harness.session(this.require(id)).busy()
    return {
      conversationId: id,
      label: row.title ?? 'Untitled helper',
      status: busy ? 'Working' : row.closedBy === 'done' ? 'Done' : row.closedAt === null ? 'Idle' : 'Closed',
      report: answerText(entries[0]).slice(0, 8000),
    }
  }

  /**
   * A thread that sees `parent` as it was at `entry` (a message in it) and continues on its own; the parent never sees
   * it. Any open conversation branches: main, a thread or a subagent. Pi forks by reference, so nothing is copied. A
   * thread from a subagent is the owner engaging with it, so that subagent stays open after it reports.
   */
  async branch(parent: string, entry: number, now: number): Promise<ConversationView> {
    this.requireOpen(parent)
    const from = this.#registered(parent)
    const source = await this.#conversation(parent)
    const id = entryId(entry)
    const [at] = (await source.entries({ minEntryId: id, maxEntryId: id }, 1, undefined, BACKGROUND)).items
    if (at === undefined || !BRANCHABLE.has(at.kind)) throw new InvalidInput({ reason: 'branch_entry' })
    const recallThrough = this.#recallAt(from, at.id)
    const extensions = { add: recallThrough === null ? [this.#kit.thread] : [this.#kit.thread, this.#kit.recall] }
    // The fork starts from the parent's agent as it was at that entry, made a thread: the host's extensions and the
    // thread's (a subagent's own selection and instructions go), its tool filter set to the parent's switches now.
    const agent = { extensions, instructions: null, tools: this.#kit.capabilities.piTools(parent) }
    const fork = await source.fork(at.id, { ownership: { kind: 'ownerless' }, agent }, BACKGROUND)
    if (from.kind === 'subagent') {
      this.#db.update(appConversations).set({ keepOpenAt: now }).where(eq(appConversations.chatId, parent)).run()
      this.#changed([parent])
    }
    return this.#insert(
      { chatId: String(fork.id), kind: 'thread', parentSession: parent, forkEntry: at.id, recallThrough },
      now,
    )
  }

  /**
   * How far a thread branched from `from` at `entry` may zoom into main's memory: main's memory as it was there when it
   * branches main, never further than its parent could; nothing when it never saw main (a subagent, a "+" thread).
   */
  #recallAt(from: Row, entry: number): number | null {
    if (from.role === 'primary') return this.#kit.memory.sizeAt(entry)
    return from.recallThrough === null ? null : Math.min(from.recallThrough, this.#kit.memory.sizeAt(entry))
  }

  /** An empty thread the owner started; main learns its name once it has one (`announce`). */
  async create(now: number): Promise<ConversationView> {
    const session = await this.#harness.sessions.create()
    const primary = this.#kit.chats.primary()
    const tools = this.#kit.capabilities.piTools(primary)
    const pi = await (await this.#harness.pi()).conversation(conversationId(session.id), BACKGROUND)
    if (pi === undefined) throw new NotFound({ what: 'conversation' })
    await pi.configure({ extensions: { add: [this.#kit.thread] }, tools }, BACKGROUND)
    return this.#insert(
      { chatId: session.id, kind: 'thread', parentSession: this.#kit.chats.primary(), mainNote: 'owed' },
      now,
    )
  }

  /** How far `zoom` reaches into main's memory from `session`: all of it from main, up to its fork from a thread. */
  recallLimit(session: string, mainSize: number): number {
    const row = this.#row(this.#kit.chats.chatOf(session) ?? '')
    return row?.role === 'primary' ? mainSize : (row?.recallThrough ?? 0)
  }

  /** Registers a subagent's conversation under the one that started it; a relay repeats it, so it is idempotent. */
  registerSubagent(
    session: string,
    parent: string,
    name: string,
    now: number,
    exclusions: readonly HelperExclusion[] = [],
  ): void {
    if (this.#row(session) !== undefined) return
    const parentChat = this.#kit.chats.chatOf(parent)
    if (parentChat === undefined) throw new NotFound({ what: 'spawner chat' })
    this.#db.transaction(() => {
      this.#db
        .insert(appConversations)
        .values({
          chatId: session,
          piSession: session,
          spawnerSession: parent,
          kind: 'subagent',
          title: name,
          parentSession: parentChat,
          createdAt: now,
        })
        .run()
      writeHelperExclusions(this.#db, session, exclusions, now)
    })
    this.#changed([session])
  }

  /** A task-created routine conversation starts empty and copies no main exclusions or announcement. */
  registerRoutine(session: string, runId: string, title: string, now: number): void {
    this.#db
      .insert(appConversations)
      .values({
        chatId: session,
        piSession: session,
        kind: 'thread',
        title,
        parentSession: this.#kit.chats.primary(),
        routineRunId: runId,
        createdAt: now,
        mainNote: null,
      })
      .onConflictDoNothing()
      .run()
    this.#changed([session])
  }

  /** Frozen passive report; acceptance records a Pi write, not a new main run or external notification. */
  async reportRoutine(input: {
    readonly runId: string
    readonly routineId: string
    readonly sessionId: string | null
    readonly outcome: string
    readonly text: string
    readonly at: number
  }): Promise<void> {
    await (
      await this.#conversation(this.#kit.chats.primary())
    ).submit(
      {
        type: 'write',
        requestId: `routine-report:${input.runId}`,
        entry: {
          kind: 'app.routine',
          data: { thread: input.sessionId, routineId: input.routineId, runId: input.runId, outcome: input.outcome },
          model: [{ role: 'user', content: input.text, timestamp: input.at }],
        },
      },
      BACKGROUND,
    )
  }

  /**
   * A note from a thread into the conversation it came from: that model sees it, labelled with the thread, and no run
   * starts. It goes in as a write submission (never a direct append), so a busy parent places it at its next boundary.
   * Returns how the parent is named, for the tool's answer.
   */
  async shareBack(thread: string, note: string, requestId: string): Promise<string> {
    const row = this.#row(thread)
    if (row?.kind !== 'thread' || row.parentSession === null) throw new InvalidInput({ reason: 'share_back' })
    const parent = this.#registered(row.parentSession)
    const model = [{ role: 'user' as const, content: authoredContent(labelOf(row), note), timestamp: Date.now() }]
    await (
      await this.#conversation(parent.chatId)
    ).submit({ type: 'write', requestId, entry: { kind: 'app.shared', data: { thread }, model } }, BACKGROUND)
    return parent.role === 'primary' ? 'main' : labelOf(parent)
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
      await this.#conversation(this.#kit.chats.primary())
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
      .where(and(eq(appConversations.chatId, thread), eq(appConversations.mainNote, 'owed')))
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
        .where(and(eq(appConversations.chatId, thread), isNull(appConversations.title)))
        .run()
      this.#changed([thread])
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
      await this.#conversation(session)
    ).entries({ maxEntryId: entryId(before - 1) }, HISTORY_PAGE, undefined, BACKGROUND)
    return { entries: page.items.toReversed(), more: page.next !== undefined }
  }

  async #conversation(session: string): Promise<Conversation> {
    const piSession = this.#kit.chats.session(session)
    const conversation = await (await this.#harness.pi()).conversation(conversationId(piSession), BACKGROUND)
    if (conversation === undefined) throw new NotFound({ what: 'conversation' })
    return conversation
  }

  /**
   * Rename, close or reopen, or pin a subagent open. Main keeps its name and never closes. Closing stops and closes the
   * conversation with everything under it; reopening opens only the one asked for.
   */
  async update(id: string, change: UpdateConversation, now: number): Promise<Updated> {
    const row = this.#registered(id)
    if (row.role === 'primary') throw new InvalidInput({ reason: 'main_thread' })
    if (change.keepOpen !== undefined && row.kind !== 'subagent') throw new InvalidInput({ reason: 'keep_open' })
    const set = {
      ...(change.title === undefined ? {} : { title: change.title }),
      ...(change.keepOpen === undefined ? {} : { keepOpenAt: change.keepOpen ? now : null }),
      ...(change.closed === false ? { closedAt: null, closedBy: null } : {}),
    }
    if (Object.keys(set).length > 0) {
      this.#db.update(appConversations).set(set).where(eq(appConversations.chatId, id)).run()
      this.#changed([id])
    }
    const closed = change.closed === true ? await this.close(id, 'owner', now) : []
    return { view: await this.#describe(this.#registered(id)), closed }
  }

  /** `id` and every conversation under it, any depth, closed ones included. */
  subtree(id: string): readonly string[] {
    return this.#db.all<{ id: string }>(sql`${tree(id)} SELECT id FROM tree`).map((row) => row.id)
  }

  /** The owner has seen `id` up to `now`, so replies until then are read. The mark only moves forward. */
  markRead(id: string, now: number): void {
    this.#registered(id)
    const moved = this.#db.all<{ session_id: string }>(
      sql`UPDATE app_conversations SET read_at = ${now}
          WHERE session_id = ${id} AND (read_at IS NULL OR read_at < ${now})
          RETURNING session_id`,
    )
    if (moved.length > 0) this.#changed([id])
  }

  /**
   * Closes `id` and every open conversation under it in one statement, then stops each, background work included (a
   * relay waiting on a subagent, a thread's subagents): a closed conversation runs nothing. Returns what it closed.
   */
  async close(id: string, by: 'owner' | 'done', now: number): Promise<readonly string[]> {
    if (this.#registered(id).role === 'primary') throw new InvalidInput({ reason: 'main_thread' })
    const closed = this.#db
      .all<{ session_id: string }>(
        sql`${tree(id)}
            UPDATE app_conversations SET closed_at = ${now}, closed_by = ${by}
            WHERE closed_at IS NULL AND session_id IN tree
            RETURNING session_id`,
      )
      .map((row) => row.session_id)
    this.#changed(closed)
    // A job done closes from its own last relay, which has nothing left to drop.
    if (by === 'owner') await this.#dropRelays(closed)
    await this.#stop(closed)
    return closed
  }

  /**
   * Stops every open subagent below `id`, through subagents of subagents: Stop in a conversation reaches the helpers it
   * started. Threads branched from it are the owner's own and keep going. Nothing still on its way to `id` or below
   * reports: a stopped job reports nothing. Call it before stopping `id` itself.
   */
  async stopSubagents(id: string): Promise<void> {
    const below = this.#db.all<{ session_id: string }>(
      sql`WITH RECURSIVE tree(id) AS (
            SELECT ${id}
            UNION
            SELECT conversation.session_id FROM app_conversations AS conversation
            JOIN tree ON conversation.parent_session = tree.id
            WHERE conversation.kind = 'subagent' AND conversation.closed_at IS NULL
          )
          SELECT id AS session_id FROM tree WHERE id <> ${id}`,
    )
    const stopping = below.map((row) => row.session_id)
    await this.#dropRelays([id, ...stopping])
    await this.#stop(stopping)
  }

  /** Stops the relays carrying messages to each subagent among `sessions` from its spawner. */
  async #dropRelays(sessions: readonly string[]): Promise<void> {
    const pi = await this.#harness.pi()
    for (const chat of sessions) {
      const row = this.#row(chat)
      if (row?.kind === 'subagent' && row.parentSession !== null)
        await dropRelaysTo(
          pi,
          conversationId(row.spawnerSession ?? this.require(row.parentSession)),
          conversationId(this.require(chat)),
        )
    }
  }

  /** Aborts each conversation across background boundaries: its runs, its queued inputs and its background tasks. */
  async #stop(sessions: readonly string[]): Promise<void> {
    const pi = await this.#harness.pi()
    for (const chat of sessions)
      await (
        await pi.conversation(conversationId(this.require(chat)), BACKGROUND)
      )?.abort(BACKGROUND, { background: true })
  }

  /** Registers a new thread with the switches its parent works under, copied in the same synchronous step. */
  async #insert(
    values: Omit<typeof appConversations.$inferInsert, 'createdAt'> & { readonly parentSession: string },
    now: number,
  ): Promise<ConversationView> {
    this.#db
      .insert(appConversations)
      .values({ ...values, piSession: values.chatId, createdAt: now })
      .run()
    this.#kit.capabilities.copy(values.parentSession, values.chatId, now)
    this.#changed([values.chatId])
    return this.#describe(this.#registered(values.chatId))
  }

  /**
   * A conversation as the owner sees it, with the messages written in it (not those it inherited). One whose Pi
   * conversation is gone still lists, with no replies, so it never takes the whole list down.
   */
  async #describe(row: Row): Promise<ConversationView> {
    const session = this.#kit.chats.session(row.chatId)
    const pi = await (await this.#harness.pi()).conversation(conversationId(session), BACKGROUND)
    const activity: ReplyStats =
      pi === undefined ? { replies: 0 } : await this.#replies.stats(session, pi, row.forkEntry ?? 0)
    return {
      id: row.chatId,
      kind: row.kind,
      ...(row.title === null ? {} : { title: row.title }),
      ...(row.parentSession === null ? {} : { parent: row.parentSession }),
      ...(row.forkEntry === null ? {} : { forkEntry: row.forkEntry }),
      createdAt: row.createdAt,
      ...(row.closedAt === null ? {} : { closedAt: row.closedAt }),
      ...(row.closedBy === null ? {} : { closedBy: row.closedBy }),
      keepOpen: row.keepOpenAt !== null,
      replies: activity.replies,
      ...(activity.lastReplyAt === undefined ? {} : { lastReplyAt: activity.lastReplyAt }),
      ...(row.readAt === null ? {} : { readAt: row.readAt }),
    }
  }
}
