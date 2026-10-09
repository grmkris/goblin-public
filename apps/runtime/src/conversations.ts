import { type ConversationView, type HelperExclusion, PERSONAL_TOPIC, type UpdateConversation } from '@goblin/contracts'
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import type { Conversation, EntryDraft, EntryId, EntryRecord, Extension } from '@earendil-works/pi-durable'
import type { PiHarness } from 'agents/harness/pi'
import type { CapabilityProfiles } from './capabilities/profiles.ts'
import { writeHelperExclusions } from './capabilities/profiles.ts'
import { registerPrimary, type ChatDirectory } from './chats/directory.ts'
import { ChatStops } from './chats/stops.ts'
import { Conflict, InvalidInput, NotFound } from './http/errors.ts'
import type { ChatMemories } from './memory/memory.ts'
import type { CheapModel } from './memory/model.ts'
import { authoredContent, threadStartedContent } from './pi/content.ts'
import { BACKGROUND, conversationId, entryId } from './pi/context.ts'
import { answerText, Subagents } from './pi/subagent-relay.ts'
import { recentMessages } from './pi/transcript.ts'
import { settledEnd } from './pi/turns.ts'
import { type ChatActivity, ReplyLedger } from './replies.ts'
import { storedAsks } from './attention.ts'
import { appConversations } from './storage/schema.ts'
import { movedFrom } from './chats/moves.ts'
import { appTopics } from './storage/topics.ts'

type Row = typeof appConversations.$inferSelect

/** What an update did: the conversation as it is now, and every conversation a Close closed (it and those below). */
export type Updated = { readonly view: ConversationView; readonly closed: readonly string[] }

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

/** A Topic's one Conversation (ADR 0032): Personal's (`primary`) or another Topic's. */
const isChannel = (row: Row): boolean => row.role === 'primary' || row.role === 'conversation'

/** Why a Topic's Conversation refuses a rename or Close: Personal's is Main; another's follows its Topic. */
const channelRefusal = (row: Row) =>
  new InvalidInput({ reason: row.role === 'primary' ? 'main_thread' : 'topic_conversation' })

/** How a conversation is named in a note it leaves elsewhere: an untitled one says so, never a made-up name. */
const labelOf = (row: Row): string => (row.title === null ? `${row.kind} (untitled)` : `${row.kind} "${row.title}"`)

/**
 * What threads need beyond the registry: their own extension, `recall` for the ones that see a Conversation's history
 * (they start with its memory view), the memories that bound their zooms, the cheap model that names them, and the
 * switches a new thread copies from the conversation it came from.
 */
export type ThreadKit = {
  readonly thread: Extension
  readonly recall: Extension
  readonly memories: ChatMemories
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
  /** Thread starts in flight by operation id: a repeat waits for the first, then finds its Thread. */
  readonly #starting = new Map<string, Promise<unknown>>()
  readonly #replies = new ReplyLedger()
  readonly #listeners = new Set<(ids: readonly string[]) => void>()
  readonly #stops: ChatStops

  constructor(db: DrizzleSqliteDODatabase, harness: PiHarness, kit: ThreadKit, now: number) {
    this.#db = db
    this.#harness = harness
    this.#kit = kit
    this.#stops = new ChatStops(db, harness, kit.chats)
    registerPrimary(db, now)
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
    if (row.role === 'persona') throw new InvalidInput({ reason: 'persona_turn' })
    if (row.closedAt !== null) throw new InvalidInput({ reason: 'conversation_closed' })
    if (this.#archived(row.topicId)) throw new InvalidInput({ reason: 'topic_archived' })
    return this.#kit.chats.session(id)
  }

  /** Whether Topic `topic` is archived: none of its chats takes new work until it is restored. */
  #archived(topic: number): boolean {
    const row = this.#db.select({ at: appTopics.archivedAt }).from(appTopics).where(eq(appTopics.id, topic)).get()
    if (row === undefined) throw new NotFound({ what: 'topic' })
    return row.at !== null
  }

  /** Whether a registered conversation is main, a thread or a subagent; anything else is `NotFound`. */
  kindOf(id: string): Row['kind'] {
    return this.#registered(id).kind
  }

  /** The immutable Pi session holding a helper's anchor and relays. */
  spawnerSession(id: string): string {
    const row = this.#registered(id)
    if (row.kind !== 'subagent' || row.parentSession === null) throw new NotFound({ what: 'spawner' })
    return row.spawnerSession ?? this.require(row.parentSession)
  }

  /** One registered conversation as the owner sees it; `undefined` when it is not registered. */
  async view(id: string): Promise<ConversationView | undefined> {
    const row = this.#row(id)
    return row === undefined ? undefined : this.#describe(row)
  }

  /** Every registered conversation, oldest first (main is the oldest), closed ones included. */
  async list(): Promise<readonly ConversationView[]> {
    const rows = this.#db
      .select()
      .from(appConversations)
      .where(sql`${appConversations.role} IS NOT 'persona'`)
      .orderBy(asc(appConversations.createdAt))
      .all()
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
    return this.#forkThread(from, source, at.id, now)
  }

  /**
   * A thread forked from `from` at `at`, in its Topic. The fork starts from the parent's agent as it was at that entry,
   * made a thread: the host's extensions and the thread's (a subagent's own selection and instructions go), its tool
   * filter set to the parent's switches now.
   */
  async #forkThread(
    from: Row,
    source: Conversation,
    at: EntryId,
    now: number,
    origin: { readonly originOp?: string } = {},
  ): Promise<ConversationView> {
    const recallThrough = this.#recallAt(from, at)
    const extensions = { add: recallThrough === null ? [this.#kit.thread] : [this.#kit.thread, this.#kit.recall] }
    const agent = { extensions, instructions: null, tools: this.#kit.capabilities.piTools(from.chatId) }
    const fork = await source.fork(at, { ownership: { kind: 'ownerless' }, agent }, BACKGROUND)
    if (from.kind === 'subagent') {
      this.#db.update(appConversations).set({ keepOpenAt: now }).where(eq(appConversations.chatId, from.chatId)).run()
      this.#changed([from.chatId])
    }
    return this.#insert(
      {
        chatId: String(fork.id),
        kind: 'thread',
        parentSession: from.chatId,
        forkEntry: at,
        recallThrough,
        topicId: from.topicId,
        ...origin,
      },
      now,
    )
  }

  /**
   * The Thread the owner's operation `op` starts from `parent`'s composer (ADR 0034): a fork at the parent's newest
   * entry outside a running turn, or an empty Thread when there is none, in the parent's Topic. One operation makes
   * one Thread, also when it is repeated concurrently: a repeat finds it by `origin_op`, and the same operation from
   * another chat is a `Conflict`. A subagent's chat starts none (its composer writes to the subagent).
   */
  async startThread(parent: string, op: string, now: number): Promise<ConversationView> {
    const previous = this.#starting.get(op) ?? Promise.resolve()
    // expected: an earlier start's failure is its own caller's; this one runs after it either way.
    const next = previous.catch(() => undefined).then(async () => this.#startOnce(parent, op, now))
    this.#starting.set(op, next)
    try {
      return await next
    } finally {
      if (this.#starting.get(op) === next) this.#starting.delete(op)
    }
  }

  async #startOnce(parent: string, op: string, now: number): Promise<ConversationView> {
    const existing = this.#db.select().from(appConversations).where(eq(appConversations.originOp, op)).get()
    if (existing !== undefined) {
      if (existing.parentSession !== parent) throw new Conflict({ reason: 'operation_used' })
      return this.#describe(existing)
    }
    this.requireOpen(parent)
    const from = this.#registered(parent)
    if (from.kind === 'subagent') throw new InvalidInput({ reason: 'start_thread' })
    const source = await this.#conversation(parent)
    const at = await settledEnd(await this.#harness.pi(), this.#kit.chats.session(parent), source)
    if (at !== undefined) return this.#forkThread(from, source, at, now, { originOp: op })
    const session = await this.#session([this.#kit.thread], parent)
    return this.#insert(
      { chatId: session, kind: 'thread', parentSession: parent, topicId: from.topicId, originOp: op },
      now,
    )
  }

  /** How far a thread cut from `chat` at `entry` may zoom into its memory (a moved Thread, ADR 0034). */
  recallAt(chat: string, entry: number): number | null {
    return this.#recallAt(this.#registered(chat), entry)
  }

  /**
   * How far a thread branched from `from` at `entry` may zoom into the memory of the Conversation above it: that memory
   * as it was there when it branches the Conversation, never further than its parent could; nothing when it never saw
   * one (a subagent, a "+" thread).
   */
  #recallAt(from: Row, entry: number): number | null {
    const memory = this.#kit.memories.of(this.#kit.chats.conversationAbove(from.chatId))
    if (isChannel(from)) return memory.sizeAt(entry)
    return from.recallThrough === null ? null : Math.min(from.recallThrough, memory.sizeAt(entry))
  }

  /**
   * An empty thread the owner started under `topic`'s Conversation (Personal's by default); that Conversation learns
   * its name once it has one (`announce`).
   */
  async create(now: number, topic: number = PERSONAL_TOPIC): Promise<ConversationView> {
    const channel = this.#kit.chats.conversationOf(topic)
    this.requireOpen(channel)
    const session = await this.#session([this.#kit.thread], channel)
    return this.#insert(
      { chatId: session, kind: 'thread', parentSession: channel, mainNote: 'owed', topicId: topic },
      now,
    )
  }

  /** A new top-level Pi session (not a fork) with `extensions` added and `like`'s tool filter. */
  async #session(extensions: readonly Extension[], like: string): Promise<string> {
    const session = await this.#harness.sessions.create()
    const tools = this.#kit.capabilities.piTools(like)
    const pi = await (await this.#harness.pi()).conversation(conversationId(session.id), BACKGROUND)
    if (pi === undefined) throw new NotFound({ what: 'conversation' })
    await pi.configure({ extensions: { add: [...extensions] }, tools }, BACKGROUND)
    return session.id
  }

  /**
   * A new Topic's Conversation (ADR 0032): a new Pi session configured like Personal's, with its tool filter, not a
   * fork, so it starts with none of Personal's transcript. `topics/ports.ts` lists it once its Topic exists.
   */
  async openConversation(): Promise<string> {
    return this.#session([], this.#kit.chats.primary())
  }

  /** Tells the listeners about chats another registry wrote (a Topic's Conversation, `topics/ports.ts`). */
  touched(ids: readonly string[]): void {
    this.#changed(ids)
  }

  /** The open chats of `topic` other than subagents: its Conversation and threads, whose work an archive stops. */
  openIn(topic: number): readonly string[] {
    return this.#db
      .select({ id: appConversations.chatId })
      .from(appConversations)
      .where(
        and(
          eq(appConversations.topicId, topic),
          isNull(appConversations.closedAt),
          ne(appConversations.kind, 'subagent'),
          sql`${appConversations.role} IS NOT 'persona'`,
        ),
      )
      .all()
      .map((row) => row.id)
  }

  /**
   * How far `zoom` reaches from `session` into the memory of the Conversation above it (`size` messages): all of it
   * from that Conversation, up to its fork from a thread.
   */
  recallLimit(session: string, size: number): number {
    const row = this.#row(this.#kit.chats.chatOf(session) ?? '')
    if (row === undefined) return 0
    return isChannel(row) ? size : (row.recallThrough ?? 0)
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
    const topicId = this.#kit.chats.topicOf(parentChat)
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
          topicId,
          createdAt: now,
        })
        .run()
      writeHelperExclusions(this.#db, session, exclusions, now)
    })
    this.#changed([session])
  }

  /**
   * Lists the fork a Persona answers in (ADR 0033): a hidden thread of its parent's Topic, never listed and never open
   * to the owner. Its switches are the parent's now; the caller narrows them with the Persona's exclusions.
   */
  async registerPersona(session: string, parentChat: string, name: string, now: number): Promise<void> {
    if (this.#row(session) !== undefined) return
    const topicId = this.#kit.chats.topicOf(parentChat)
    await this.#insert(
      { chatId: session, role: 'persona', kind: 'thread', title: name, parentSession: parentChat, topicId },
      now,
    )
  }

  /**
   * Where a routine of `topic` lives and reports: that Topic's Conversation, or Personal's while the Topic is archived
   * or gone, so a routine left running (archive leaves schedules alone) is never reported out of sight.
   */
  #routineHome(topic: number): { readonly chat: string; readonly topic: number } {
    const row = this.#db.select().from(appTopics).where(eq(appTopics.id, topic)).get()
    return row === undefined || row.archivedAt !== null
      ? { chat: this.#kit.chats.primary(), topic: PERSONAL_TOPIC }
      : { chat: row.chatId, topic }
  }

  /**
   * A task-created routine conversation starts empty and copies no exclusions or announcement; it sits under its
   * routine's Topic's Conversation.
   */
  registerRoutine(session: string, runId: string, title: string, now: number, topic: number = PERSONAL_TOPIC): void {
    const home = this.#routineHome(topic)
    this.#db
      .insert(appConversations)
      .values({
        chatId: session,
        piSession: session,
        kind: 'thread',
        title,
        parentSession: home.chat,
        topicId: home.topic,
        routineRunId: runId,
        createdAt: now,
        mainNote: null,
      })
      .onConflictDoNothing()
      .run()
    this.#changed([session])
  }

  /**
   * Frozen passive report into the routine's Topic's Conversation (Personal's by default, or while that Topic is
   * archived); acceptance records a Pi write, not a new run or external notification.
   */
  async reportRoutine(input: {
    readonly runId: string
    readonly routineId: string
    readonly sessionId: string | null
    readonly outcome: string
    readonly text: string
    readonly at: number
    readonly topic?: number
  }): Promise<void> {
    await this.#passiveWrite(this.#routineHome(input.topic ?? PERSONAL_TOPIC).chat, {
      type: 'write',
      requestId: `routine-report:${input.runId}`,
      entry: {
        kind: 'app.routine',
        data: { thread: input.sessionId, routineId: input.routineId, runId: input.runId, outcome: input.outcome },
        model: [{ role: 'user', content: input.text, timestamp: input.at }],
      },
    })
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
    await this.#passiveWrite(parent.chatId, {
      type: 'write',
      requestId,
      entry: { kind: 'app.shared', data: { thread }, model },
    })
    if (parent.role === 'primary') return 'main'
    return parent.role === 'conversation' ? `#${parent.title ?? 'topic'}` : labelOf(parent)
  }

  /**
   * Tells its Topic's Conversation, once, about a thread the owner started with "+": when it has a title (the cheap
   * model's or the owner's), that Conversation gets a note naming it, which its model sees and which starts no run.
   * Nothing said in the thread goes with it, and a later rename does not rewrite it. The write's request id makes a
   * retry after a crash the same note.
   */
  async announce(thread: string): Promise<void> {
    const row = this.#row(thread)
    if (row?.kind !== 'thread' || row.mainNote !== 'owed' || row.title === null) return
    const model = [{ role: 'user' as const, content: threadStartedContent(row.title), timestamp: Date.now() }]
    await this.#passiveWrite(this.#kit.chats.conversationAbove(thread), {
      type: 'write',
      requestId: `thread-started:${thread}`,
      entry: { kind: 'app.thread_started', data: { thread }, model },
    })
    this.#db
      .update(appConversations)
      .set({ mainNote: 'written' })
      .where(and(eq(appConversations.chatId, thread), eq(appConversations.mainNote, 'owed')))
      .run()
  }

  async #passiveWrite(chat: string, submission: Extract<Parameters<Conversation['submit']>[0], { type: 'write' }>) {
    return this.#kit.chats.passiveWrite(chat, async (session) => {
      const conversation = await (await this.#harness.pi()).conversation(conversationId(session), BACKGROUND)
      if (conversation === undefined) throw new NotFound({ what: 'conversation' })
      return conversation.submit(submission, BACKGROUND)
    })
  }

  /**
   * Writes `entry` into `chat` as a passive entry: its model sees it at its next turn and no run starts. The request
   * id makes a repeat the same write. `placed` waits, outside the chat's lock, until the write is in the transcript
   * (at once when idle, else at the chat's next boundary) and gives its entry id.
   */
  async writeEntry(chat: string, requestId: string, entry: EntryDraft) {
    const submission = await this.#passiveWrite(chat, { type: 'write', requestId, entry })
    return {
      placed: async () => {
        const settled = await submission.wait(BACKGROUND)
        return settled.status === 'done' && settled.entry !== undefined ? Number(settled.entry) : undefined
      },
    }
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
    if (isChannel(row)) throw channelRefusal(row)
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
    return this.#stops.subtree(id)
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
    const target = this.#registered(id)
    if (isChannel(target)) throw channelRefusal(target)
    const closed = this.#stops.closeTree(id, by, now)
    this.#changed(closed)
    // A job done closes from its own last relay, which has nothing left to drop.
    if (by === 'owner') await this.#stops.dropRelays(closed)
    await this.#stops.stop(closed)
    return closed
  }

  /**
   * Stops every open subagent below `id`, through subagents of subagents: Stop in a conversation reaches the helpers it
   * started. Threads branched from it are the owner's own and keep going. Nothing still on its way to `id` or below
   * reports: a stopped job reports nothing. Call it before stopping `id` itself.
   */
  async stopSubagents(id: string): Promise<void> {
    const stopping = this.#stops.subagentsBelow(id)
    await this.#stops.dropRelays([id, ...stopping])
    await this.#stops.stop(stopping)
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
    const activity: ChatActivity =
      pi === undefined ? { replies: 0, asks: [] } : await this.#replies.stats(session, pi, row.forkEntry ?? 0)
    const attention = [...activity.asks, ...storedAsks(this.#db, { id: row.chatId, session }, Date.now())]
    return {
      id: row.chatId,
      ...(row.role === 'primary' ? { primary: true } : {}),
      topic: row.topicId,
      ...(isChannel(row) ? { conversation: true } : {}),
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
      ...(attention.length === 0 ? {} : { attention }),
      ...movedFrom(this.#db, row.originOp),
    }
  }
}
