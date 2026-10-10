import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import {
  type CreateConversation,
  type HelperExclusion,
  type MoveReceipt,
  type MoveToThread,
  PERSONAL_TOPIC,
  type UpdateConversation,
} from '@goblin/contracts'
import type { EntryDraft, Submission } from '@earendil-works/pi-durable'
import * as Clock from 'effect/Clock'
import type { Budget } from '../budget.ts'
import { makeChatOperations } from '../chats/operations.ts'
import {
  ChatDirectory,
  type ChatDb,
  type ChatRow,
  ChatsInstance,
  chatOfSession,
  chatSession,
  conversationAbove,
  conversationOfTopic,
  isConversationChat,
  isHiddenChat,
  primaryChat,
  registerChat,
  topicOfChat,
} from '../chats/directory.ts'
import { ChatMover, MovesInstance } from '../chats/mover.ts'
import { ChatOperations, Chats, Conversations, Moves, type RoutineReport, type ThreadAnchor } from '../chats/service.ts'
import { epochSeconds, nowSeconds } from '../clock.ts'
import { ConversationRegistry, ConversationsInstance } from '../conversations.ts'
import { CheapModels } from '../memory/model.ts'
import type { Models } from '../models.ts'
import { attempt, attemptSync } from '../http/errors.ts'
import { FlowEvents, withFlow } from '../observability/flows.ts'
import { writeLine } from '../observability/logger.ts'
import { safeErrorType } from '../observability/report.ts'
import { BACKGROUND } from '../pi/context.ts'
import { syncWith } from '../runtime/boundary.ts'
import { Changes } from '../runtime/changes.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'
import type { FoundationServices } from './core.ts'

/** Start step 4: the chat directory's reads as one object, for the synchronous code that takes one. */
export const ChatDirectoryLive: Layer.Layer<ChatsInstance, never, Db> = Layer.effect(
  ChatsInstance,
  Db.useSync((db) => new ChatDirectory(db)),
)

/**
 * Start step 10: the conversation registry, made once; main is registered here. Each write tells
 * `conversations.changed` which conversations it changed, before it returns (the Apps registry and the feed follow).
 */
export const ConversationRegistryLive: Layer.Layer<
  ConversationsInstance,
  never,
  AgentInput | Db | Changes | CheapModels
> = Layer.effect(
  ConversationsInstance,
  Effect.gen(function* () {
    const input = yield* AgentInput
    const cheap = yield* CheapModels
    const kit = {
      thread: input.thread,
      recall: input.memory.recall,
      namer: cheap('naming'),
      subagentTools: input.subagentTools,
    }
    // The registry is Promise code that writes synchronously: it tells the change bus inline, on its own stack.
    const changes = yield* Changes
    const tell = syncWith(yield* Effect.context<Changes>())
    const changed = (ids: readonly string[]) => tell(changes.publish('conversations.changed', { ids }))
    return new ConversationRegistry(yield* Db, input.harness, kit, nowSeconds(), changed)
  }),
)

/**
 * Start step 13: Move to thread, the one mover. A move a restart interrupted finishes once the services are up again
 * (ADR 0034); it never holds up the start, so its reconcile runs on while the steps after this one are built.
 */
export const MoverLive: Layer.Layer<MovesInstance, never, AgentInput | Db | ConversationsInstance> = Layer.effect(
  MovesInstance,
  Effect.gen(function* () {
    const input = yield* AgentInput
    const moves = new ChatMover({
      db: yield* Db,
      harness: input.harness,
      // The mover is Promise code: it takes the chat's one lock through the bridge (no plan check).
      withChat: (chat, run) => input.local(ChatOperations.use((operations) => operations.withChat(chat, attempt(run)))),
      conversations: yield* ConversationsInstance,
      subagentTools: input.subagentTools,
      thread: input.thread,
      recall: input.memory.recall,
      ...input.moves,
    })
    moves.reconcile().catch((error: unknown) => {
      writeLine('error', { event: 'failure', where: 'moves.reconcile', 'error.type': safeErrorType(error) })
    })
    return moves
  }),
)

/** One of the directory's reads (chats/directory.ts). */
type Lookup<Args extends readonly unknown[], A> = (db: ChatDb, ...args: Args) => A

/** A directory read as a `Chats` method: its typed failures as `AppError`, anything else `Internal`. */
const read = <Args extends readonly unknown[], A>(db: ChatDb, name: string, lookup: Lookup<Args, A>) =>
  Effect.fn(name)(function* (...args: Args) {
    return yield* attemptSync(() => lookup(db, ...args))
  })

/** The chat directory natively: reads over the agent's SQLite (it keeps no state) and the one row inserter. */
export const ChatsLive = Layer.effect(
  Chats,
  Effect.gen(function* () {
    const db = yield* Db
    const chatOf = read(db, 'Chats.chatOf', chatOfSession)
    return Chats.of({
      primary: primaryChat,
      session: read(db, 'Chats.session', chatSession),
      chatOf: (session: string) => Effect.map(chatOf(session), Option.fromNullishOr),
      topicOf: read(db, 'Chats.topicOf', topicOfChat),
      conversationOf: read(db, 'Chats.conversationOf', conversationOfTopic),
      conversationAbove: read(db, 'Chats.conversationAbove', conversationAbove),
      isConversation: read(db, 'Chats.isConversation', isConversationChat),
      isHidden: read(db, 'Chats.isHidden', isHiddenChat),
      register: read(db, 'Chats.register', (database, row: ChatRow, again: 'fail' | 'keep' = 'fail') =>
        registerChat(database, row, again),
      ),
    })
  }),
)

/** The chat operations natively (chats/operations.ts), over the agent's database. */
export const ChatOperationsLive = Layer.effect(ChatOperations, makeChatOperations)

/** The registry's reads over the agent's one `ConversationRegistry`. */
const registryReads = (conversations: ConversationRegistry) => ({
  require: Effect.fn('Conversations.require')(function* (chat: string) {
    return yield* attemptSync(() => conversations.require(chat))
  }),
  requireOpen: Effect.fn('Conversations.requireOpen')(function* (chat: string) {
    return yield* attemptSync(() => conversations.requireOpen(chat))
  }),
  kindOf: Effect.fn('Conversations.kindOf')(function* (chat: string) {
    return yield* attemptSync(() => conversations.kindOf(chat))
  }),
  spawnerSession: Effect.fn('Conversations.spawnerSession')(function* (chat: string) {
    return yield* attemptSync(() => conversations.spawnerSession(chat))
  }),
  view: Effect.fn('Conversations.view')(function* (chat: string) {
    return Option.fromNullishOr(yield* attempt(() => conversations.view(chat)))
  }),
  list: Effect.withSpan(
    attempt(() => conversations.list()),
    'Conversations.list',
  ),
  helperReference: Effect.fn('Conversations.helperReference')(function* (chat: string) {
    return yield* attempt(() => conversations.helperReference(chat))
  }),
  openIn: Effect.fn('Conversations.openIn')(function* (topic: number) {
    return yield* attemptSync(() => conversations.openIn(topic))
  }),
  recallAt: Effect.fn('Conversations.recallAt')(function* (chat: string, entry: number) {
    return yield* attemptSync(() => conversations.recallAt(chat, entry))
  }),
  recallLimit: Effect.fn('Conversations.recallLimit')(function* (session: string, size: number) {
    return yield* attemptSync(() => conversations.recallLimit(session, size))
  }),
  history: Effect.fn('Conversations.history')(function* (chat: string, before: number) {
    return yield* attempt(() => conversations.history(chat, before))
  }),
  subtree: Effect.fn('Conversations.subtree')(function* (chat: string) {
    return yield* attemptSync(() => conversations.subtree(chat))
  }),
})

/** The registry's new chats over the one `ConversationRegistry`: Threads, Topic Conversations and registrations. */
const registryChats = (conversations: ConversationRegistry) => ({
  openConversation: Effect.withSpan(
    attempt(() => conversations.openConversation()),
    'Conversations.openConversation',
  ),
  registerSubagent: Effect.fn('Conversations.registerSubagent')(function* (
    session: string,
    parent: string,
    name: string,
    exclusions: readonly HelperExclusion[] = [],
  ) {
    const now = yield* epochSeconds
    return yield* attemptSync(() => conversations.registerSubagent(session, parent, name, now, exclusions))
  }),
  registerPersona: Effect.fn('Conversations.registerPersona')(function* (
    session: string,
    parentChat: string,
    name: string,
  ) {
    const now = yield* epochSeconds
    return yield* attempt(() => conversations.registerPersona(session, parentChat, name, now))
  }),
  registerRoutine: Effect.fn('Conversations.registerRoutine')(function* (
    session: string,
    runId: string,
    title: string,
    topic?: number,
  ) {
    const now = yield* epochSeconds
    return yield* attemptSync(() => conversations.registerRoutine(session, runId, title, now, topic))
  }),
})

/** The flow, and the receipt's kind, of a thread operation by where it starts its Thread. */
const threadFlow = (anchor: ThreadAnchor) => (anchor === 'latest' ? 'start' : anchor === 'empty' ? 'empty' : 'reply')

/**
 * Thread operations (ADR 0034) over the one registry: the Thread made once per operation, its receipt in the chat it
 * came from (moved on to `settled` with the Thread it made), and its `start`, `reply` or `empty` flow. A create with an
 * operation id is that chat's thread operation (C4); one without stays the plain create it always was.
 */
const threadStarts = (
  conversations: ConversationRegistry,
  db: ChatDb,
  operations: ChatOperations['Service'],
  flows: FlowEvents['Service'],
) => {
  const startThread = Effect.fn('Conversations.startThread')(function* (
    parent: string,
    operationId: string,
    anchor: ThreadAnchor,
  ) {
    const kind = threadFlow(anchor)
    const flow = { flow: kind, via: 'app', actor: 'owner', parentChat: parent, operationId } as const
    const started = operations.tracked(
      parent,
      operationId,
      { kind, origin: 'owner' },
      () =>
        Effect.flatMap(epochSeconds, (now) =>
          attempt(() => conversations.startThread(parent, operationId, anchor, now)),
        ),
      (thread) => ({ state: 'settled', targetChat: thread.view.id }),
    )
    const thread = yield* started.pipe(
      withFlow(flow, ({ view, existing }) => ({ chat: view.id, status: existing ? 'replayed' : 'ok' })),
      Effect.provideService(FlowEvents, flows),
    )
    return thread.view
  })
  const create = Effect.fn('Conversations.create')(function* (input: CreateConversation) {
    const { from, topic, operationId } = input
    if (operationId !== undefined) {
      if (from !== undefined) return yield* startThread(from.conversation, operationId, { entry: from.entry })
      const channel = yield* attemptSync(() => conversationOfTopic(db, topic ?? PERSONAL_TOPIC))
      return yield* startThread(channel, operationId, 'empty')
    }
    const now = yield* epochSeconds
    if (from !== undefined) return yield* attempt(() => conversations.branch(from.conversation, from.entry, now))
    const channel = yield* attemptSync(() => conversationOfTopic(db, topic ?? PERSONAL_TOPIC))
    return yield* attempt(() => conversations.createIn(channel, now))
  })
  return { startThread, create }
}

/** The registry's writes into existing chats over the one `ConversationRegistry`. */
/**
 * A Close as its `close` flow (plan §4): the owner's from the app, or a subagent's own once its job is done; `count` is
 * how many chats it closed, and a Close that closed none (all were closed already) is a replay.
 */
const closing = <A, E, R>(
  flows: FlowEvents['Service'],
  chat: string,
  by: 'owner' | 'done',
  close: Effect.Effect<A, E, R>,
  count: (closed: A) => number,
) => {
  const who =
    by === 'owner' ? ({ via: 'app', actor: 'owner' } as const) : ({ via: 'system', actor: 'subagent' } as const)
  const flow = { flow: 'close', chat, ...who } as const
  return close.pipe(
    withFlow(flow, (closed) => ({ count: count(closed), status: count(closed) === 0 ? 'replayed' : 'ok' })),
    Effect.provideService(FlowEvents, flows),
  )
}

/** A thread's note into the chat it came from, as its own `share` flow (plan §4). */
const shareBackWith = (
  conversations: ConversationRegistry,
  operations: ChatOperations['Service'],
  flows: FlowEvents['Service'],
) =>
  Effect.fn('Conversations.shareBack')(function* (thread: string, note: string, requestId: string) {
    const flow = { flow: 'share', via: 'tool', actor: 'agent', chat: thread, operationId: requestId } as const
    const shared = Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis
      const share = yield* attemptSync(() => conversations.shareBack(thread, note, requestId, at))
      yield* operations.passiveWrite(share.chat, share.write)
      return share
    })
    const { sharedWith } = yield* shared.pipe(
      withFlow(flow, ({ chat }) => ({ parentChat: chat })),
      Effect.provideService(FlowEvents, flows),
    )
    return sharedWith
  })

const registryWrites = (
  conversations: ConversationRegistry,
  operations: ChatOperations['Service'],
  flows: FlowEvents['Service'],
) => ({
  touched: Effect.fn('Conversations.touched')(function* (chats: readonly string[]) {
    return yield* attemptSync(() => conversations.touched(chats))
  }),
  reportRoutine: Effect.fn('Conversations.reportRoutine')(function* (report: RoutineReport) {
    const { chat, write } = yield* attemptSync(() => conversations.routineReport(report))
    yield* operations.passiveWrite(chat, write)
  }),
  shareBack: shareBackWith(conversations, operations, flows),
  announce: Effect.fn('Conversations.announce')(function* (thread: string) {
    const at = yield* Clock.currentTimeMillis
    const owed = yield* attemptSync(() => conversations.announcement(thread, at))
    if (owed === undefined) return false
    yield* operations.passiveWrite(owed.chat, owed.write)
    return yield* attemptSync(() => conversations.announced(thread))
  }),
  writeEntry: Effect.fn('Conversations.writeEntry')(function* (chat: string, requestId: string, entry: EntryDraft) {
    const submission = yield* operations.passiveWrite(chat, { requestId, entry })
    return { placed: placedOf(submission) }
  }),
  nameIfUntitled: Effect.fn('Conversations.nameIfUntitled')(function* (thread: string) {
    return yield* attempt(() => conversations.nameIfUntitled(thread))
  }),
  update: Effect.fn('Conversations.update')(function* (chat: string, change: UpdateConversation) {
    const now = yield* epochSeconds
    const updating = attempt(() => conversations.update(chat, change, now))
    if (change.closed !== true) return yield* updating
    return yield* closing(flows, chat, 'owner', updating, (updated) => updated.closed.length)
  }),
  markRead: Effect.fn('Conversations.markRead')(function* (chat: string) {
    const now = yield* epochSeconds
    return yield* attemptSync(() => conversations.markRead(chat, now))
  }),
  close: Effect.fn('Conversations.close')(function* (chat: string, by: 'owner' | 'done') {
    const now = yield* epochSeconds
    return yield* closing(
      flows,
      chat,
      by,
      attempt(() => conversations.close(chat, by, now)),
      (closed) => closed.length,
    )
  }),
  stopSubagents: Effect.fn('Conversations.stopSubagents')(function* (chat: string) {
    return yield* attempt(() => conversations.stopSubagents(chat))
  }),
})

/**
 * Where a passive write landed: its entry id once it is in the transcript (at once when the chat is idle, else at its
 * next boundary), none when Pi did not place it. It waits outside the chat's lock.
 */
const placedOf = (submission: Submission) =>
  Effect.map(
    attempt(() => submission.wait(BACKGROUND)),
    (settled) =>
      settled.status === 'done' && settled.entry !== undefined ? Option.some(Number(settled.entry)) : Option.none(),
  )

/**
 * The registry over the one `ConversationRegistry` (start step 10), reading the time from the Clock as the programs do. Its passive
 * writes go through `ChatOperations.passiveWrite`: under the chat's lock, each with its receipt.
 */
const ConversationsAdapter = Layer.effect(
  Conversations,
  Effect.gen(function* () {
    const conversations = yield* ConversationsInstance
    const db = yield* Db
    const operations = yield* ChatOperations
    const flows = yield* FlowEvents
    return Conversations.of({
      ...registryReads(conversations),
      ...registryChats(conversations),
      ...threadStarts(conversations, db, operations, flows),
      ...registryWrites(conversations, operations, flows),
    })
  }),
)

/** How a move's receipt goes on from what the mover answered: refused with its reason, or settled with its Thread. */
const moveEnd = (receipt: MoveReceipt) =>
  receipt.state === 'refused'
    ? ({ state: 'refused', reason: receipt.reason ?? 'refused' } as const)
    : ({
        state: receipt.state === 'settled' ? 'settled' : 'submitted',
        ...(receipt.thread === undefined ? {} : { targetChat: receipt.thread }),
      } as const)

/**
 * Move to thread over the one `ChatMover` (start step 13): the move once per operation (`app_chat_moves`), with its `move` receipt
 * in the chat (settled with the Thread it made, or refused with the mover's reason) and its `move` flow.
 */
const MovesAdapter = Layer.effect(
  Moves,
  Effect.gen(function* () {
    const moves = yield* MovesInstance
    const operations = yield* ChatOperations
    const flows = yield* FlowEvents
    return Moves.of({
      move: Effect.fn('Moves.move')(function* (chat: string, input: MoveToThread) {
        const flow = { flow: 'move', via: 'app', actor: 'owner', chat, operationId: input.operationId } as const
        const moved = operations.tracked(
          chat,
          input.operationId,
          { kind: 'move', origin: 'owner' },
          ({ existing }) =>
            Effect.flatMap(epochSeconds, (now) =>
              Effect.map(
                attempt(() => moves.move(chat, input, now)),
                (receipt) => ({ receipt, existing }),
              ),
            ),
          ({ receipt }) => moveEnd(receipt),
        )
        const settled = yield* moved.pipe(
          withFlow(flow, ({ receipt, existing }) =>
            receipt.state === 'refused'
              ? { status: 'refused', errorType: receipt.reason ?? 'refused' }
              : { status: existing ? 'replayed' : 'ok' },
          ),
          Effect.provideService(FlowEvents, flows),
        )
        return settled.receipt
      }),
      moving: Effect.fn('Moves.moving')(function* (chat: string) {
        return yield* attemptSync(() => moves.moving(chat))
      }),
    })
  }),
)

/**
 * The conversation services after the start (chats/service.ts). `Chats` and `ChatOperations` are native: SQLite reads
 * and receipts, each chat's one lock in `KeyedLock` (the mover and the Topic seed take it through the bridge), Pi
 * through `PiSessions`, flows through `FlowEvents`. `Conversations` and `Moves` are served over the one registry and
 * mover (start steps 10 and 13), which the Topic ports, the Apps registry and the workspace feed share; their passive
 * writes, receipts and flows go through `ChatOperations` and `FlowEvents`.
 */
export const ConversationLive: Layer.Layer<
  Chats | ChatOperations | Conversations | Moves,
  never,
  FoundationServices | Budget | Models
> = Layer.mergeAll(ChatsLive, ConversationsAdapter, MovesAdapter).pipe(Layer.provideMerge(ChatOperationsLive))
