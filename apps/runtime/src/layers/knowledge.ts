import type { Tx } from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { UsageStore, recordUse } from '../budget.ts'
import { creditRates } from '../budget-credits.ts'
import { ChatsInstance } from '../chats/directory.ts'
import { ChatOperations, Chats } from '../chats/service.ts'
import { nowSeconds } from '../clock.ts'
import { toAppError } from '../http/errors.ts'
import {
  ChatMemories,
  MemoriesInstance,
  forgetFrom,
  recordView,
  rememberedCount,
  rememberedThrough,
  viewReach,
} from '../memory/memory.ts'
import { CheapModel, CheapModels } from '../memory/model.ts'
import { Memories, type MemoryLine } from '../memory/service.ts'
import { memoryModelId, modelOptions } from '../models.ts'
import { KeyedLock } from '../observability/lock.ts'
import { TranscriptIndex, TranscriptsInstance, piTranscripts } from '../retrieval/index.ts'
import { ChatRetrieval, Retrieval, retrievalOver } from '../retrieval/service.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'
import { auxReporter } from '../telemetry/report.ts'

// The knowledge layers. Four are steps of the agent's start, in its order (layers/index.ts): the cheap models (step 3),
// the memory engine (5), the transcript index (12) and the memory's activation of every Topic Conversation (14). The
// memory engine and the index are shared with the conversations, Topics and the mover by their instance tags
// (`MemoriesInstance`, `TranscriptsInstance`). After the start, `KnowledgeLive` serves memory and retrieval: what a
// memory remembers, how far its view reaches and what a Move forgets over the agent's database, a view placed through
// the chat's passive write (lane C), and every transcript catch-up on its session's turn of the agent's KeyedLock.

/** A call into a shared instance's async code: a failure is the `AppError` it threw, anything else `Internal`. */
const fromPromise = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: toAppError })

/**
 * Start step 3: the deployment's cheap model (`GOBLIN_MEMORY_MODEL`), one per housekeeping purpose. Its tokens count in
 * the daily budget through the usage ledger, written as `Budget.record` writes it: the model reports what it spent
 * from inside its Promise, synchronously, which cannot run the Budget service's Effect. So this needs no Budget, and the
 * memory engine needs nothing built after it.
 */
export const CheapModelsLive: Layer.Layer<CheapModels, never, AgentInput | Db> = Layer.effect(
  CheapModels,
  Effect.gen(function* () {
    const { env, pi, telemetry } = yield* AgentInput
    const ledger = new UsageStore(yield* Db)
    const rates = creditRates(env.MODEL_CREDIT_RATES)
    const id = memoryModelId(env.MEMORY_MODEL, modelOptions(env.MODELS, env.MODEL_ID))
    return (purpose) =>
      new CheapModel(
        pi.models,
        id,
        (use) => recordUse(ledger, rates, use, nowSeconds(), id),
        auxReporter(telemetry, purpose),
      )
  }),
)

/**
 * Start step 5: each Topic Conversation's memory, the one engine, with the memory extensions it turns on and the
 * native fixture's fold override.
 */
export const MemoryEngineLive: Layer.Layer<MemoriesInstance, never, AgentInput | Db | ChatsInstance | CheapModels> =
  Layer.effect(
    MemoriesInstance,
    Effect.gen(function* () {
      const input = yield* AgentInput
      const cheap = yield* CheapModels
      const fold = Number(input.env.MEMORY_FOLD_TOKENS ?? Number.NaN)
      const options = Number.isFinite(fold) ? { foldTokens: fold } : {}
      const deps = { db: yield* Db, harness: input.harness, model: cheap('memory'), chats: yield* ChatsInstance }
      return new ChatMemories(deps, options, [input.memory.memory, input.memory.recall])
    }),
  )

/** Start step 12: cross-Topic retrieval's one transcript index (ADR 0035), which a Move to thread also reassigns. */
export const TranscriptsLive: Layer.Layer<TranscriptsInstance, never, AgentInput | Db> = Layer.effect(
  TranscriptsInstance,
  Effect.gen(function* () {
    const { harness } = yield* AgentInput
    return new TranscriptIndex(yield* Db, piTranscripts(harness), nowSeconds)
  }),
)

/** Start step 14: every Topic Conversation without memory yet is given it, after main is registered (step 10). */
export const ActivateMemoriesLive: Layer.Layer<never, never, MemoriesInstance> = Layer.effectDiscard(
  Effect.flatMap(MemoriesInstance, (memories) => Effect.promise(() => memories.activateConversations())),
)

/** Each Topic Conversation's memory: its counts over the database, its engine's work through the one engine. */
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

/**
 * Cross-Topic retrieval over the one transcript index, its rerank on the cheap model, every catch-up under the agent's
 * KeyedLock.
 */
const RetrievalLive = Layer.effect(
  Retrieval,
  Effect.gen(function* () {
    const cheap = yield* CheapModels
    const retrieval = new ChatRetrieval(yield* TranscriptsInstance, cheap('retrieval'), nowSeconds)
    return retrievalOver(retrieval, yield* KeyedLock)
  }),
)

/** Lane K's services after the start: memory and retrieval. */
export const KnowledgeLive: Layer.Layer<
  Memories | Retrieval,
  never,
  Db | Chats | ChatOperations | MemoriesInstance | TranscriptsInstance | CheapModels | KeyedLock
> = Layer.mergeAll(MemoriesLive, RetrievalLive)
