import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import type { MoveReceipt, MoveToThread } from '@goblin/contracts'
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
  registerPrimary,
  topicOfChat,
} from '../chats/directory.ts'
import { makeRegistryCore } from '../chats/conversations/core.ts'
import { registryReads } from '../chats/conversations/reads.ts'
import { registryThreads } from '../chats/conversations/threads.ts'
import { registryWrites } from '../chats/conversations/writes.ts'
import { ChatMover, MovesInstance } from '../chats/mover.ts'
import { ChatOperations, Chats, Conversations, Moves } from '../chats/service.ts'
import { epochSeconds } from '../clock.ts'
import { ConversationsInstance } from '../conversations.ts'
import { CheapModels } from '../memory/model.ts'
import type { Models } from '../models.ts'
import { attempt, attemptSync } from '../http/errors.ts'
import { FlowEvents, withFlow } from '../observability/flows.ts'
import { KeyedLock } from '../observability/lock.ts'
import { writeLine } from '../observability/logger.ts'
import { safeErrorType } from '../observability/report.ts'
import { SingleFlight } from '../observability/single-flight.ts'
import { promiseWith, syncWith } from '../runtime/boundary.ts'
import { Changes } from '../runtime/changes.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'
import type { FoundationServices } from './core.ts'

/** Start step 4: the chat directory's reads as one object, for the synchronous code that takes one. */
export const ChatDirectoryLive: Layer.Layer<ChatsInstance, never, Db> = Layer.effect(
  ChatsInstance,
  Db.useSync((db) => new ChatDirectory(db)),
)

/** Start step 10: main is registered, once (a retained or rebound binding is never overwritten). */
export const PrimaryChatLive: Layer.Layer<never, never, Db> = Layer.effectDiscard(
  Effect.gen(function* () {
    const db = yield* Db
    const now = yield* epochSeconds
    yield* Effect.sync(() => registerPrimary(db, now))
  }),
)

/**
 * Start step 13: Move to thread, the one mover. A move a restart interrupted finishes once the services are up again
 * (ADR 0034); it never holds up the start, so its reconcile runs on while the steps after this one are built.
 */
export const MoverLive: Layer.Layer<MovesInstance, never, AgentInput | Db | Changes> = Layer.effect(
  MovesInstance,
  Effect.gen(function* () {
    const input = yield* AgentInput
    // The mover is Promise code that writes synchronously: it tells the change bus inline, on its own stack.
    const changes = yield* Changes
    const tell = syncWith(yield* Effect.context<Changes>())
    const moves = new ChatMover({
      db: yield* Db,
      harness: input.harness,
      // The mover is Promise code: it takes the chat's one lock through the bridge (no plan check).
      withChat: (chat, run) => input.local(ChatOperations.use((operations) => operations.withChat(chat, attempt(run)))),
      touched: (ids) => tell(changes.publish('conversations.changed', { ids })),
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

/**
 * The registry of the owner's chats natively (chats/conversations/): its reads, its new chats and its writes over the
 * agent's database and Pi. A thread operation is admitted once per operation id under the KeyedLock
 * (`thread-op:<op>`), a thread is named once at a time (`SingleFlight`), each chat's reply tally is kept by the
 * service, and every write tells `conversations.changed` what it changed, inside the write.
 */
export const ConversationsLive = Layer.effect(
  Conversations,
  Effect.gen(function* () {
    const core = yield* makeRegistryCore
    const operations = yield* ChatOperations
    const flows = yield* FlowEvents
    const threads = registryThreads(core, { operations, flows, locks: yield* KeyedLock })
    const namer = (yield* CheapModels)('naming')
    const writes = registryWrites(core, { operations, flows, flights: yield* SingleFlight, namer })
    return Conversations.of({ ...registryReads(core), ...threads, ...writes })
  }),
)

/** The registry's Promise view, for the Topic ports and the workspace feed: it runs the native service's methods. */
const ConversationsInstanceLive = Layer.effect(
  ConversationsInstance,
  Effect.gen(function* () {
    const conversations = yield* Conversations
    const context = yield* Effect.context()
    const run = promiseWith(context)
    return {
      openConversation: () => run(conversations.openConversation),
      // The change bus runs its handlers inline and never waits, so this ends on the caller's stack.
      touched: (ids) => syncWith(context)(conversations.touched(ids)),
      list: () => run(conversations.list),
      view: (id) => run(Effect.map(conversations.view(id), Option.getOrUndefined)),
    }
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
 * The conversation services after the start (chats/service.ts), all native but `Moves`: SQLite reads and receipts,
 * each chat's one lock in `KeyedLock` (the mover takes it through the bridge), Pi through `PiSessions`, flows through
 * `FlowEvents`. `Moves` is served over the one mover (start step 13); its receipts and flows go through
 * `ChatOperations` and `FlowEvents`.
 */
export const ConversationLive: Layer.Layer<
  Chats | ChatOperations | Conversations | ConversationsInstance | Moves,
  never,
  FoundationServices | Budget | Models
> = Layer.mergeAll(ChatsLive, ConversationsInstanceLive, MovesAdapter).pipe(
  Layer.provideMerge(ConversationsLive),
  Layer.provideMerge(ChatOperationsLive),
)
