import type { PiHarness } from 'agents/harness/pi'
import { UsageDoc } from '@earendil-works/pi-durable'
import * as Schema from 'effect/Schema'
import { and, eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { appRoutineUsageProjection } from '../storage/routines.ts'
import type { RoutineRunStore } from './runs.ts'
import { BACKGROUND, conversationId } from '../pi/context.ts'
import { type CreditRates, milliCredits } from '../budget-credits.ts'

const Counters = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  totalTokens: Schema.Number,
})
const Usage = Schema.Struct({
  models: Schema.Record(Schema.String, Counters),
  tools: Schema.Record(Schema.String, Counters),
})

/**
 * Project cumulative committed pi.usage, including compaction attempts, with app-only dedupe watermarks: tokens for the
 * routine's own caps, and Credits at each model's rate for the owner's daily budget (ADR 0026).
 */
export class RoutineUsage {
  readonly #db: DrizzleSqliteDODatabase
  readonly #runs: RoutineRunStore
  readonly #rates: CreditRates
  readonly #harness: PiHarness
  constructor(db: DrizzleSqliteDODatabase, runs: RoutineRunStore, rates: CreditRates, harness: PiHarness) {
    this.#db = db
    this.#runs = runs
    this.#rates = rates
    this.#harness = harness
  }
  project(session: string, value: unknown, at: number): void {
    const run = this.#runs.session(session)
    if (run === undefined) return
    const usage = Schema.decodeUnknownSync(Usage)(value)
    for (const [bucket, counters] of Object.entries(usage.models)) {
      const model = bucket.slice(bucket.indexOf('/') + 1)
      this.#bucket(run.id, `models:${bucket}`, counters.totalTokens, milliCredits(counters, model, this.#rates), at)
    }
    for (const [bucket, counters] of Object.entries(usage.tools))
      this.#bucket(run.id, `tools:${bucket}`, counters.totalTokens, milliCredits(counters, undefined, this.#rates), at)
  }
  /** `tokens` and `milli` are the bucket's cumulative totals; what is new since the watermark is recorded once. */
  #bucket(runId: string, model: string, tokens: number, milli: number, at: number): void {
    if (!Number.isFinite(tokens) || tokens < 0) return
    this.#db.transaction(() => {
      const row = this.#db
        .select()
        .from(appRoutineUsageProjection)
        .where(and(eq(appRoutineUsageProjection.runId, runId), eq(appRoutineUsageProjection.model, model)))
        .get()
      const delta = tokens - (row?.tokens ?? 0)
      if (delta <= 0) return
      const credits = Math.max(0, milli - (row?.milliCredits ?? 0))
      this.#runs.recordUsage(runId, `committed:${model}:${tokens}`, delta, credits, at)
      this.#db
        .insert(appRoutineUsageProjection)
        .values({ runId, model, tokens, milliCredits: milli })
        .onConflictDoUpdate({
          target: [appRoutineUsageProjection.runId, appRoutineUsageProjection.model],
          set: { tokens, milliCredits: milli },
        })
        .run()
    })
  }
  async snapshot(session: string): Promise<void> {
    const value = await (await this.#harness.pi()).snapshot(UsageDoc, conversationId(session), BACKGROUND)
    if (value !== undefined) this.project(session, value, Date.now())
  }
}

export async function installRoutineUsage(
  harness: PiHarness,
  projection: RoutineUsage,
  runs: RoutineRunStore,
): Promise<void> {
  const pi = await harness.pi()
  const unsubscribe = pi.subscribeCommits((publication) => {
    for (const change of publication.changes) {
      if (
        change.type !== 'document' ||
        change.record.kind !== 'pi.usage' ||
        change.conversationId === undefined ||
        change.value === null
      )
        continue
      projection.project(String(change.conversationId), change.value, Date.now())
    }
  })
  pi.subscribeClose(unsubscribe)
  for (const record of runs.live()) if (record.sessionId !== null) await projection.snapshot(record.sessionId)
}
