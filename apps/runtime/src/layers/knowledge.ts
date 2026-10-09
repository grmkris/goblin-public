import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { ChatOperations, Chats } from '../chats/service.ts'
import { toAppError } from '../http/errors.ts'
import { forgetFrom, recordView, rememberedCount, rememberedThrough, viewReach } from '../memory/memory.ts'
import { Memories, type MemoryLine } from '../memory/service.ts'
import type { SkillRequestOptions } from '../mcp/types.ts'
import { KeyedLock } from '../observability/lock.ts'
import { Retrieval, retrievalOver } from '../retrieval/service.ts'
import { Db } from '../runtime/db.ts'
import {
  Learner as LearnerInstance,
  Memories as MemoriesInstance,
  Retrieval as RetrievalInstance,
  Skills as SkillsInstance,
} from '../services.ts'
import { Learner, Skills } from '../skills/service.ts'

// Lane K's native layers (wave 3). What a memory remembers, how far its view reaches and what a Move forgets are read
// and written over the agent's database; a view is placed through the chat's passive write (lane C), and every
// transcript catch-up takes its session's turn on the agent's KeyedLock. The memory engine (Pi and the cheap model),
// the retrieval rerank (the cheap model), the skills library (its listing cache and the MCP connections) and the
// learner (its busy set) are instances the legacy start makes and shares with services outside lane K (the mover,
// conversations, Topics, the Events consumer, agent apps): until the conductor moves that start into this layer at
// integration, these layers read that one instance by its tag and never make a second one.

/** A call into a shared instance's async code: a failure is the `AppError` it threw, anything else `Internal`. */
const fromPromise = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: toAppError })
/** The same for its synchronous code. */
const fromSync = <A>(run: () => A) => Effect.try({ try: run, catch: toAppError })

/** Each Topic Conversation's memory: its counts over the database, its engine's work through the started instance. */
const MemoriesLive = Layer.effect(
  Memories,
  Effect.gen(function* () {
    const db = yield* Db
    const chats = yield* Chats
    const operations = yield* ChatOperations
    const engine = yield* MemoriesInstance
    return Memories.of({
      status: Effect.fn('Memories.status')(function* (chat?: string) {
        const target = chat === undefined ? chats.primary : yield* chats.conversationAbove(chat)
        return { messages: rememberedCount(db, target), summarized: viewReach(db, target) }
      }),
      size: Effect.fn('Memories.size')(function* (chat: string) {
        return yield* Effect.sync(() => rememberedCount(db, chat))
      }),
      sizeAt: Effect.fn('Memories.sizeAt')(function* (chat: string, entry: number) {
        return yield* Effect.sync(() => rememberedThrough(db, chat, entry))
      }),
      activate: Effect.fn('Memories.activate')(function* (chat: string) {
        yield* fromPromise(() => engine.activate(chat))
      }),
      activateConversations: Effect.fn('Memories.activateConversations')(function* () {
        yield* fromPromise(() => engine.activateConversations())
      }),
      truncate: Effect.fn('Memories.truncate')(function* (chat: string, size: number) {
        yield* Effect.sync(() => forgetFrom(db, chat, size))
      }),
      // A view is placed as a passive write under the chat's admission lock, never beside a send (K1), and recorded
      // only once the write was admitted: a failed write is placed again by the next step.
      step: Effect.fn('Memories.step')(function* (chat: string, signal: AbortSignal) {
        const next = yield* fromPromise(() => engine.of(chat).advance(signal))
        if (next === 'more' || next === 'done') return next
        yield* operations.passiveWrite(chat, next.write)
        yield* Effect.sync(() => recordView(db, chat, next.through))
        return 'done' as const
      }),
      startBuilder: Effect.fn('Memories.startBuilder')(function* (chat: string, start: (tx: Tx) => Promise<void>) {
        yield* fromPromise(() => engine.of(chat).startBuilder(start))
      }),
      zoom: Effect.fn('Memories.zoom')(function* (chat: string, line: MemoryLine, limit: number) {
        return yield* fromPromise(() => engine.of(chat).zoom(line.id, line.n, limit))
      }),
    })
  }),
)

/** Cross-Topic retrieval over the started ChatRetrieval and its index, every catch-up under the agent's KeyedLock. */
const RetrievalLive = Layer.effect(
  Retrieval,
  Effect.gen(function* () {
    return retrievalOver(yield* RetrievalInstance, yield* KeyedLock)
  }),
)

/** Skills from the owner's MCP libraries, through the started library (its listing cache is shared). */
const SkillsLive = Layer.effect(
  Skills,
  Effect.gen(function* () {
    const library = yield* SkillsInstance
    return Skills.of({
      sources: Effect.fn('Skills.sources')(function* () {
        return yield* Effect.sync(() => library.sources())
      }),
      enabled: Effect.fn('Skills.enabled')(function* (serverId: string) {
        return yield* Effect.sync(() => library.enabled(serverId))
      }),
      setEnabled: Effect.fn('Skills.setEnabled')(function* (serverId: string, enabled: boolean) {
        yield* fromSync(() => library.setEnabled(serverId, enabled))
      }),
      invalidate: Effect.fn('Skills.invalidate')(function* (serverId: string, unavailable?: boolean) {
        yield* Effect.sync(() => library.invalidate(serverId, unavailable))
      }),
      catalog: Effect.fn('Skills.catalog')(function* (
        options?: SkillRequestOptions,
        include?: (serverId: string) => boolean,
      ) {
        return yield* fromPromise(() => library.catalog(options, include))
      }),
      activate: Effect.fn('Skills.activate')(function* (
        session: string,
        handle: string,
        options?: SkillRequestOptions,
      ) {
        return yield* fromPromise(() => library.activate(session, handle, options))
      }),
      activateSelection: Effect.fn('Skills.activateSelection')(function* (
        session: string,
        serverId: string,
        uri: string,
        options: SkillRequestOptions,
      ) {
        return yield* fromPromise(() => library.activateSelection(session, serverId, uri, options))
      }),
      read: Effect.fn('Skills.read')(function* (
        session: string,
        handle: string,
        path: string,
        options?: SkillRequestOptions,
      ) {
        return yield* fromPromise(() => library.read(session, handle, path, options))
      }),
    })
  }),
)

/** The skill learner, through the started one (its busy set keeps one consideration per conversation). */
const LearnerLive = Layer.effect(
  Learner,
  Effect.gen(function* () {
    const learner = yield* LearnerInstance
    return Learner.of({
      consider: Effect.fn('Learner.consider')(function* (conversation: ConversationId, signal?: AbortSignal) {
        return yield* fromPromise(() => learner.consider(conversation, signal))
      }),
    })
  }),
)

/** Lane K's services: memory, retrieval and skills. */
export const KnowledgeLive = Layer.mergeAll(MemoriesLive, RetrievalLive, SkillsLive, LearnerLive)
