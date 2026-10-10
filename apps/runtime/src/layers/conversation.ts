import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import type { Budget } from '../budget.ts'
import { makeChatOperations } from '../chats/operations.ts'
import {
  type ChatDb,
  type ChatRow,
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
import { makeMoves } from '../chats/mover.ts'
import { ChatOperations, Chats, Conversations, Moves } from '../chats/service.ts'
import { epochSeconds } from '../clock.ts'
import { CheapModels } from '../memory/model.ts'
import type { Models } from '../models.ts'
import { attemptSync } from '../http/errors.ts'
import { FlowEvents } from '../observability/flows.ts'
import { KeyedLock } from '../observability/lock.ts'
import { SingleFlight } from '../observability/single-flight.ts'
import { Db } from '../runtime/db.ts'
import type { FoundationServices } from './core.ts'

/** Start step 10: main is registered, once (a retained or rebound binding is never overwritten). */
export const PrimaryChatLive: Layer.Layer<never, never, Db> = Layer.effectDiscard(
  Effect.gen(function* () {
    const db = yield* Db
    const now = yield* epochSeconds
    yield* Effect.sync(() => registerPrimary(db, now))
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

/** Move to thread natively (chats/mover.ts): its reconcile runs in the layer's scope, never holding up the start. */
const MovesLive = Layer.effect(Moves, makeMoves)

/**
 * The conversation services after the start (chats/service.ts), natively: SQLite reads and receipts, each chat's one
 * lock in `KeyedLock`, single flights in `SingleFlight`, Pi through `PiSessions`, flows through `FlowEvents`, and
 * changes through `Changes`.
 */
export const ConversationLive: Layer.Layer<
  Chats | ChatOperations | Conversations | Moves,
  never,
  FoundationServices | Budget | Models
> = Layer.mergeAll(ChatsLive, MovesLive).pipe(
  Layer.provideMerge(ConversationsLive),
  Layer.provideMerge(ChatOperationsLive),
)
