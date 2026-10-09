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
import { type ChatDirectory, ChatReads, type ChatRow, registerChat } from '../chats/directory.ts'
import { epochSeconds, instanceCall } from '../chats/instance.ts'
import { ChatOperations, Chats, Conversations, Moves, type RoutineReport, type ThreadAnchor } from '../chats/service.ts'
import type { ConversationRegistry } from '../conversations.ts'
import type { Models } from '../models.ts'
import { type AppError, toAppError } from '../http/errors.ts'
import { FlowEvents } from '../observability/flows.ts'
import { safeErrorType } from '../observability/report.ts'
import { failedFlow } from '../organize/flows.ts'
import { BACKGROUND } from '../pi/context.ts'
import { Db } from '../runtime/db.ts'
import { Chats as LegacyChats, Conversations as LegacyConversations, Moves as LegacyMoves } from '../services.ts'
import type { FoundationServices } from './core.ts'

/** A synchronous call into the legacy instances or the stores, its throw a typed `AppError`. */
const sync = <A>(run: () => A) => Effect.try({ try: run, catch: toAppError })

/** The chat directory natively: reads over the agent's SQLite (`ChatReads` keeps no state) and the one row inserter. */
export const ChatsLive = Layer.effect(
  Chats,
  Effect.gen(function* () {
    const db = yield* Db
    const chats = new ChatReads(db)
    return Chats.of({
      primary: chats.primary(),
      session: Effect.fn('Chats.session')(function* (chat: string) {
        return yield* sync(() => chats.session(chat))
      }),
      chatOf: Effect.fn('Chats.chatOf')(function* (session: string) {
        return Option.fromNullishOr(yield* sync(() => chats.chatOf(session)))
      }),
      topicOf: Effect.fn('Chats.topicOf')(function* (chat: string) {
        return yield* sync(() => chats.topicOf(chat))
      }),
      conversationOf: Effect.fn('Chats.conversationOf')(function* (topic: number) {
        return yield* sync(() => chats.conversationOf(topic))
      }),
      conversationAbove: Effect.fn('Chats.conversationAbove')(function* (chat: string) {
        return yield* sync(() => chats.conversationAbove(chat))
      }),
      isConversation: Effect.fn('Chats.isConversation')(function* (chat: string) {
        return yield* sync(() => chats.isConversation(chat))
      }),
      isHidden: Effect.fn('Chats.isHidden')(function* (chat: string) {
        return yield* sync(() => chats.isHidden(chat))
      }),
      register: Effect.fn('Chats.register')(function* (row: ChatRow, again: 'fail' | 'keep' = 'fail') {
        return yield* sync(() => registerChat(db, row, again))
      }),
    })
  }),
)

/**
 * The chat operations natively (chats/operations.ts). The one legacy piece they read is the chat directory's lock,
 * which the mover, the registry's own writes and the Topic ports still take.
 */
export const ChatOperationsLive = Layer.effect(
  ChatOperations,
  LegacyChats.use((locks) => makeChatOperations({ locks })),
)

/** The registry's reads over the legacy `ConversationRegistry`. */
const registryReads = (conversations: ConversationRegistry) => ({
  require: Effect.fn('Conversations.require')(function* (chat: string) {
    return yield* sync(() => conversations.require(chat))
  }),
  requireOpen: Effect.fn('Conversations.requireOpen')(function* (chat: string) {
    return yield* sync(() => conversations.requireOpen(chat))
  }),
  kindOf: Effect.fn('Conversations.kindOf')(function* (chat: string) {
    return yield* sync(() => conversations.kindOf(chat))
  }),
  spawnerSession: Effect.fn('Conversations.spawnerSession')(function* (chat: string) {
    return yield* sync(() => conversations.spawnerSession(chat))
  }),
  view: Effect.fn('Conversations.view')(function* (chat: string) {
    return Option.fromNullishOr(yield* instanceCall(() => conversations.view(chat)))
  }),
  list: Effect.withSpan(
    instanceCall(() => conversations.list()),
    'Conversations.list',
  ),
  helperReference: Effect.fn('Conversations.helperReference')(function* (chat: string) {
    return yield* instanceCall(() => conversations.helperReference(chat))
  }),
  openIn: Effect.fn('Conversations.openIn')(function* (topic: number) {
    return yield* sync(() => conversations.openIn(topic))
  }),
  recallAt: Effect.fn('Conversations.recallAt')(function* (chat: string, entry: number) {
    return yield* sync(() => conversations.recallAt(chat, entry))
  }),
  recallLimit: Effect.fn('Conversations.recallLimit')(function* (session: string, size: number) {
    return yield* sync(() => conversations.recallLimit(session, size))
  }),
  history: Effect.fn('Conversations.history')(function* (chat: string, before: number) {
    return yield* instanceCall(() => conversations.history(chat, before))
  }),
  subtree: Effect.fn('Conversations.subtree')(function* (chat: string) {
    return yield* sync(() => conversations.subtree(chat))
  }),
})

/** The registry's new chats over the legacy `ConversationRegistry`: Threads, Topic Conversations and registrations. */
const registryChats = (conversations: ConversationRegistry) => ({
  openConversation: Effect.withSpan(
    instanceCall(() => conversations.openConversation()),
    'Conversations.openConversation',
  ),
  registerSubagent: Effect.fn('Conversations.registerSubagent')(function* (
    session: string,
    parent: string,
    name: string,
    exclusions: readonly HelperExclusion[] = [],
  ) {
    const now = yield* epochSeconds
    return yield* sync(() => conversations.registerSubagent(session, parent, name, now, exclusions))
  }),
  registerPersona: Effect.fn('Conversations.registerPersona')(function* (
    session: string,
    parentChat: string,
    name: string,
  ) {
    const now = yield* epochSeconds
    return yield* instanceCall(() => conversations.registerPersona(session, parentChat, name, now))
  }),
  registerRoutine: Effect.fn('Conversations.registerRoutine')(function* (
    session: string,
    runId: string,
    title: string,
    topic?: number,
  ) {
    const now = yield* epochSeconds
    return yield* sync(() => conversations.registerRoutine(session, runId, title, now, topic))
  }),
})

/** The flow, and the receipt's kind, of a thread operation by where it starts its Thread. */
const threadFlow = (anchor: ThreadAnchor) => (anchor === 'latest' ? 'start' : anchor === 'empty' ? 'empty' : 'reply')

/**
 * Thread operations (ADR 0034) over the legacy registry: the Thread made once per operation, its receipt in the chat it
 * came from (moved on to `settled` with the Thread it made), and its `start`, `reply` or `empty` flow. A create with an
 * operation id is that chat's thread operation (C4); one without stays the plain create it always was.
 */
const threadStarts = (
  conversations: ConversationRegistry,
  chats: ChatDirectory,
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
    const started = Effect.gen(function* () {
      yield* operations.record(parent, operationId, { kind, origin: 'owner' })
      const now = yield* epochSeconds
      const { view, existing } = yield* instanceCall(() => conversations.startThread(parent, operationId, anchor, now))
      yield* operations.advance(parent, operationId, { state: 'settled', targetChat: view.id })
      yield* flows.record({ ...flow, chat: view.id, status: existing ? 'replayed' : 'ok' })
      return view
    })
    const refused = (error: AppError) =>
      Effect.andThen(
        flows.record({ ...flow, ...failedFlow(error) }),
        operations.advance(parent, operationId, { state: 'refused', reason: safeErrorType(error) }),
      )
    return yield* started.pipe(Effect.tapError(refused))
  })
  const create = Effect.fn('Conversations.create')(function* (input: CreateConversation) {
    const { from, topic, operationId } = input
    if (operationId !== undefined) {
      if (from !== undefined) return yield* startThread(from.conversation, operationId, { entry: from.entry })
      const channel = yield* sync(() => chats.conversationOf(topic ?? PERSONAL_TOPIC))
      return yield* startThread(channel, operationId, 'empty')
    }
    const now = yield* epochSeconds
    if (from !== undefined) return yield* instanceCall(() => conversations.branch(from.conversation, from.entry, now))
    const channel = yield* sync(() => chats.conversationOf(topic ?? PERSONAL_TOPIC))
    return yield* instanceCall(() => conversations.createIn(channel, now))
  })
  return { startThread, create }
}

/** The registry's writes into existing chats over the legacy `ConversationRegistry`. */
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
    Effect.tap((closed) =>
      flows.record({ ...flow, count: count(closed), status: count(closed) === 0 ? 'replayed' : 'ok' }),
    ),
    Effect.tapError((error) => flows.record({ ...flow, ...failedFlow(error) })),
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
      const { chat, write, sharedWith } = yield* sync(() => conversations.shareBack(thread, note, requestId, at))
      yield* operations.passiveWrite(chat, write)
      yield* flows.record({ ...flow, parentChat: chat, status: 'ok' })
      return sharedWith
    })
    return yield* shared.pipe(Effect.tapError((error) => flows.record({ ...flow, ...failedFlow(error) })))
  })

const registryWrites = (
  conversations: ConversationRegistry,
  operations: ChatOperations['Service'],
  flows: FlowEvents['Service'],
) => ({
  touched: Effect.fn('Conversations.touched')(function* (chats: readonly string[]) {
    return yield* sync(() => conversations.touched(chats))
  }),
  reportRoutine: Effect.fn('Conversations.reportRoutine')(function* (report: RoutineReport) {
    const { chat, write } = yield* sync(() => conversations.routineReport(report))
    yield* operations.passiveWrite(chat, write)
  }),
  shareBack: shareBackWith(conversations, operations, flows),
  announce: Effect.fn('Conversations.announce')(function* (thread: string) {
    const at = yield* Clock.currentTimeMillis
    const owed = yield* sync(() => conversations.announcement(thread, at))
    if (owed === undefined) return false
    yield* operations.passiveWrite(owed.chat, owed.write)
    return yield* sync(() => conversations.announced(thread))
  }),
  writeEntry: Effect.fn('Conversations.writeEntry')(function* (chat: string, requestId: string, entry: EntryDraft) {
    const submission = yield* operations.passiveWrite(chat, { requestId, entry })
    return { placed: placedOf(submission) }
  }),
  nameIfUntitled: Effect.fn('Conversations.nameIfUntitled')(function* (thread: string) {
    return yield* instanceCall(() => conversations.nameIfUntitled(thread))
  }),
  update: Effect.fn('Conversations.update')(function* (chat: string, change: UpdateConversation) {
    const now = yield* epochSeconds
    const updating = instanceCall(() => conversations.update(chat, change, now))
    if (change.closed !== true) return yield* updating
    return yield* closing(flows, chat, 'owner', updating, (updated) => updated.closed.length)
  }),
  markRead: Effect.fn('Conversations.markRead')(function* (chat: string) {
    const now = yield* epochSeconds
    return yield* sync(() => conversations.markRead(chat, now))
  }),
  close: Effect.fn('Conversations.close')(function* (chat: string, by: 'owner' | 'done') {
    const now = yield* epochSeconds
    return yield* closing(
      flows,
      chat,
      by,
      instanceCall(() => conversations.close(chat, by, now)),
      (closed) => closed.length,
    )
  }),
  stopSubagents: Effect.fn('Conversations.stopSubagents')(function* (chat: string) {
    return yield* instanceCall(() => conversations.stopSubagents(chat))
  }),
})

/**
 * Where a passive write landed: its entry id once it is in the transcript (at once when the chat is idle, else at its
 * next boundary), none when Pi did not place it. It waits outside the chat's lock.
 */
const placedOf = (submission: Submission) =>
  Effect.map(
    instanceCall(() => submission.wait(BACKGROUND)),
    (settled) =>
      settled.status === 'done' && settled.entry !== undefined ? Option.some(Number(settled.entry)) : Option.none(),
  )

/**
 * The registry over the legacy `ConversationRegistry`, reading the time from the Clock as the programs do. Its passive
 * writes go through `ChatOperations.passiveWrite`: under the chat's lock, each with its receipt.
 */
const ConversationsAdapter = Layer.effect(
  Conversations,
  Effect.gen(function* () {
    const conversations = yield* LegacyConversations
    const chats = yield* LegacyChats
    const operations = yield* ChatOperations
    const flows = yield* FlowEvents
    return Conversations.of({
      ...registryReads(conversations),
      ...registryChats(conversations),
      ...threadStarts(conversations, chats, operations, flows),
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
 * Move to thread over the legacy `ChatMover`: the move once per operation (`app_chat_moves`), with its `move` receipt
 * in the chat (settled with the Thread it made, or refused with the mover's reason) and its `move` flow.
 */
const MovesAdapter = Layer.effect(
  Moves,
  Effect.gen(function* () {
    const moves = yield* LegacyMoves
    const operations = yield* ChatOperations
    const flows = yield* FlowEvents
    return Moves.of({
      move: Effect.fn('Moves.move')(function* (chat: string, input: MoveToThread) {
        const flow = { flow: 'move', via: 'app', actor: 'owner', chat, operationId: input.operationId } as const
        const moved = Effect.gen(function* () {
          const { existing } = yield* operations.record(chat, input.operationId, { kind: 'move', origin: 'owner' })
          const now = yield* epochSeconds
          const receipt = yield* instanceCall(() => moves.move(chat, input, now))
          yield* operations.advance(chat, input.operationId, moveEnd(receipt))
          const status =
            receipt.state === 'refused'
              ? ({ status: 'refused', errorType: receipt.reason ?? 'refused' } as const)
              : ({ status: existing ? 'replayed' : 'ok' } as const)
          yield* flows.record({ ...flow, ...status })
          return receipt
        })
        return yield* moved.pipe(Effect.tapError((error) => flows.record({ ...flow, ...failedFlow(error) })))
      }),
      moving: Effect.fn('Moves.moving')(function* (chat: string) {
        return yield* sync(() => moves.moving(chat))
      }),
    })
  }),
)

/**
 * Lane C's services (chats/service.ts). `Chats` and `ChatOperations` are native: SQLite reads and receipts, the chat
 * lock in `KeyedLock`, Pi through `PiSessions`, flows through `FlowEvents`; admission still holds the legacy
 * directory's lock inside its own while the mover, the registry's own writes and the Topic ports take it.
 * `Conversations` and `Moves` wrap the legacy start's registry and mover (layers/legacy.ts): stateful instances the
 * Topic ports, the Apps registry and the workspace feed share, built natively when the legacy start goes. Their
 * passive writes, receipts and flows already go through `ChatOperations` and `FlowEvents`.
 */
export const ConversationLive: Layer.Layer<
  Chats | ChatOperations | Conversations | Moves,
  never,
  FoundationServices | Budget | Models
> = Layer.mergeAll(ChatsLive, ConversationsAdapter, MovesAdapter).pipe(Layer.provideMerge(ChatOperationsLive))
