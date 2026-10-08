import { Config, Effect, FileSystem, Option } from 'effect'
import { join } from 'node:path'
import { appendJson, readLedger, lockRun, fail } from './store.ts'
import { type Provider } from './decisions-provider.ts'
import { executeAttempt } from './decisions-attempt.ts'
import { Attempt, Row, arms, type Arm, type Fixture } from '../src/decisions/schema.ts'
import { modelFor, type Manifest } from '../src/decisions/manifest.ts'
import { batches, localRow, type Batch } from '../src/decisions/runner.ts'
import { totals } from '../src/decisions/budget.ts'
import { rules } from '../src/decisions/rules.ts'

export interface RunOptions {
  readonly root: string
  readonly manifest: Manifest
  readonly fixtures: readonly Fixture[]
  readonly provider: Provider
  readonly available: (keyEnv: string) => Effect.Effect<boolean>
  readonly status: (line: string) => Effect.Effect<void>
  readonly steer: Effect.Effect<void>
}
const skippedRows = (batch: Batch, reason: string): Row[] =>
  batch.fixtures.map((fixture) => {
    if (batch.arm === 'critic' && rules(fixture).decided) return localRow(fixture, batch.arm, batch.repetition)
    return { ...localRow(fixture, batch.arm, batch.repetition), route: 'skipped', answers: null, error: reason }
  })
export const configured = (keyEnv: string) =>
  Config.option(Config.Redacted(keyEnv)).pipe(Effect.map(Option.isSome), Effect.orDie)

interface RunState {
  readonly rows: Row[]
  readonly records: Attempt[]
  readonly skipped: Record<string, string>
  halted: boolean
}
const persistRows = Effect.fn('decisions.persist')(function* (path: string, rows: readonly Row[]) {
  for (const row of rows) yield* appendJson(path, row)
})
const runBatch = Effect.fn('decisions.batch')(function* (
  options: RunOptions,
  state: RunState,
  batch: Batch,
  reason: string | null,
) {
  yield* options.steer
  if (batch.selected.length === 0) {
    state.rows.push(...batch.fixtures.map((fixture) => localRow(fixture, batch.arm, batch.repetition)))
    return reason
  }
  if (reason !== null || state.halted) {
    const skipped = reason ?? 'campaign-halted'
    state.rows.push(...skippedRows(batch, skipped))
    state.skipped[batch.arm] = skipped
    return skipped
  }
  const dir = join(options.root, options.manifest.runId)
  const result = yield* executeAttempt({
    manifest: options.manifest,
    model: modelFor(options.manifest, batch.arm),
    batch,
    dir,
    ledger: join(options.root, 'attempts.jsonl'),
    records: state.records,
    provider: options.provider,
  }).pipe(Effect.catchTag('BenchError', () => Effect.succeed(null)))
  if (result === null) {
    state.halted = true
    state.rows.push(...skippedRows(batch, 'admission-stopped'))
    return 'admission-stopped'
  }
  state.rows.push(...result.rows)
  yield* persistRows(
    join(dir, 'results.jsonl'),
    result.rows.filter((row) => row.route === 'model'),
  )
  const status = result.finished.status
  const used = totals(state.records)
  yield* options.status(
    'RUN ' + join(dir, 'manifest.json') + ' charged=' + used.usd.toFixed(6) + ' USD attempts=' + used.requests,
  )
  if (![400, 401, 402, 403, 404, 405].includes(status)) return null
  yield* options.status('BLOCKED ' + batch.arm + ' HTTP ' + status)
  state.skipped[batch.arm] = 'http-' + status
  return 'http-' + status
})
const runArm = Effect.fn('decisions.arm')(function* (options: RunOptions, state: RunState, arm: Arm) {
  yield* options.steer
  if (arm === 'rules') {
    const local = batches(options.fixtures, arm, options.manifest.repetitions).flatMap((batch) =>
      batch.fixtures.map((fixture) => localRow(fixture, arm, batch.repetition)),
    )
    state.rows.push(...local)
    return
  }
  const available = yield* options.available(modelFor(options.manifest, arm).keyEnv)
  let reason = available ? null : 'missing-credential'
  for (const batch of batches(options.fixtures, arm, options.manifest.repetitions))
    reason = yield* runBatch(options, state, batch, reason)
})
/** One coordinator and one durable allowance span every trial in this lane. No implicit retry. */
export const runDecisions = Effect.fn('decisions.run')(function* (options: RunOptions) {
  const { manifest } = options
  const dir = join(options.root, manifest.runId)
  const fs = yield* FileSystem.FileSystem
  yield* lockRun(options.root)
  const ledger = join(options.root, 'attempts.jsonl')
  const records = [...(yield* readLedger(ledger, Attempt))]
  const previous = yield* readLedger(join(dir, 'results.jsonl'), Row)
  if (previous.length > 0) return yield* fail('Run already has results; preserve it and use a new manifest')
  yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 })
  const state: RunState = { rows: [], records, skipped: {}, halted: false }
  for (const arm of arms) yield* runArm(options, state, arm)
  // Append local/skip outcomes once; network outcomes were appended immediately after settlement.
  yield* persistRows(
    join(dir, 'results.jsonl'),
    state.rows.filter((row) => row.route !== 'model'),
  )
  yield* fs.writeFileString(
    join(dir, 'completion.json'),
    JSON.stringify({ halted: state.halted, skipped: state.skipped, totals: totals(records) }, null, 2),
    { mode: 0o600, flag: 'wx' },
  )
  return state
})
