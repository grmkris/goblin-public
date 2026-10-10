import type { Tx } from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { recordUse, usageLedger } from '../budget.ts'
import { creditRates } from '../budget-credits.ts'
import { ChatOperations, Chats } from '../chats/service.ts'
import { nowSeconds } from '../clock.ts'
import { attempt } from '../http/errors.ts'
import { type MemoryEngine, activateConversations, activateMemory, memoryOf } from '../memory/memory.ts'
import { CheapModel, CheapModels } from '../memory/model.ts'
import { Memories, type MemoryLine } from '../memory/service.ts'
import { forgetFrom, recordView, rememberedCount, rememberedThrough, viewReach } from '../memory/store.ts'
import { memoryModelId, modelOptions } from '../models.ts'
import { KeyedLock } from '../observability/lock.ts'
import { piTranscripts } from '../retrieval/index.ts'
import { Retrieval, retrievalOver } from '../retrieval/service.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'
import { auxReporter } from '../telemetry/report.ts'

// The knowledge layers. Two are steps of the agent's start, in its order (layers/index.ts): the cheap models (step 3)
// and the memory's activation of every Topic Conversation (9). After the start, `KnowledgeLive` serves memory and retrieval: what a memory remembers, how far its
// view reaches and what a Move forgets over the agent's database, a view placed through the chat's passive write, and
// the transcript index over the agent's database, every catch-up on its session's turn of the agent's KeyedLock.

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
    const ledger = usageLedger(yield* Db)
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
 * Each Topic Conversation's memory as the agent makes it: the agent's database and Pi, the cheap model that
 * summarizes, the memory extensions a Conversation gets, and the native fixture's fold override.
 */
const memoryEngine: Effect.Effect<MemoryEngine, never, AgentInput | Db | CheapModels> = Effect.gen(function* () {
  const input = yield* AgentInput
  const cheap = yield* CheapModels
  const fold = Number(input.env.MEMORY_FOLD_TOKENS ?? Number.NaN)
  return {
    deps: { db: yield* Db, harness: input.harness, model: cheap('memory') },
    options: Number.isFinite(fold) ? { foldTokens: fold } : {},
    extensions: [input.memory.memory, input.memory.recall],
  }
})

/** Start step 9: every Topic Conversation without memory yet is given it, after main is registered (step 7). */
export const ActivateMemoriesLive: Layer.Layer<never, never, AgentInput | Db | CheapModels> = Layer.effectDiscard(
  Effect.flatMap(memoryEngine, (engine) => Effect.promise(() => activateConversations(engine))),
)

/** Each Topic Conversation's memory: its counts over the database, its building, views and zooms over its engine. */
const MemoriesLive = Layer.effect(
  Memories,
  Effect.gen(function* () {
    const db = yield* Db
    const chats = yield* Chats
    const operations = yield* ChatOperations
    const engine = yield* memoryEngine
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
        yield* attempt(() => activateMemory(engine, chat))
      }),
      activateConversations: Effect.fn('Memories.activateConversations')(function* () {
        yield* attempt(() => activateConversations(engine))
      }),
      truncate: Effect.fn('Memories.truncate')(function* (chat: string, size: number) {
        yield* Effect.sync(() => forgetFrom(db, chat, size))
      }),
      // A view is placed as a passive write under the chat's admission lock, never beside a send, and recorded
      // only once the write was admitted: a failed write is placed again by the next step.
      step: Effect.fn('Memories.step')(function* (chat: string, signal: AbortSignal) {
        const next = yield* attempt(() => memoryOf(engine, chat).advance(signal))
        if (next === 'more' || next === 'done') return next
        yield* operations.passiveWrite(chat, next.write)
        yield* Effect.sync(() => recordView(db, chat, next.through))
        return 'done' as const
      }),
      startBuilder: Effect.fn('Memories.startBuilder')(function* (chat: string, start: (tx: Tx) => Promise<void>) {
        yield* attempt(() => memoryOf(engine, chat).startBuilder(start))
      }),
      zoom: Effect.fn('Memories.zoom')(function* (chat: string, line: MemoryLine, limit: number) {
        return yield* attempt(() => memoryOf(engine, chat).zoom(line.id, line.n, limit))
      }),
    })
  }),
)

/**
 * Cross-Topic retrieval (ADR 0035) over the transcript index in the agent's database, Pi's transcripts read through its
 * harness, its rerank on the cheap model, every catch-up under the agent's KeyedLock.
 */
const RetrievalLive = Layer.effect(
  Retrieval,
  Effect.gen(function* () {
    const { harness } = yield* AgentInput
    const cheap = yield* CheapModels
    const deps = { db: yield* Db, source: piTranscripts(harness), model: cheap('retrieval') }
    return retrievalOver(deps, yield* KeyedLock)
  }),
)

/** The knowledge services after the start: memory and retrieval. */
export const KnowledgeLive: Layer.Layer<
  Memories | Retrieval,
  never,
  AgentInput | Db | Chats | ChatOperations | CheapModels | KeyedLock
> = Layer.mergeAll(MemoriesLive, RetrievalLive)
