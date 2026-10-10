import { DateTime, Effect, FileSystem } from 'effect'
import { join } from 'node:path'
import { appendJson, writeJson, fail } from './store.ts'
import { parseJson, type Provider } from './decisions-provider.ts'
import type { Attempt } from '../src/decisions/schema.ts'
import type { Manifest, Model } from '../src/decisions/manifest.ts'
import type { Batch } from '../src/decisions/runner.ts'
import { requestBody, modelRows } from '../src/decisions/runner.ts'
import { admission, cost, settle } from '../src/decisions/budget.ts'
import { packet, decodeAnswers, chatAnswer, usageOf } from '../src/decisions/wire.ts'

export interface AttemptOptions {
  readonly manifest: Manifest
  readonly model: Model
  readonly batch: Batch
  readonly dir: string
  readonly ledger: string
  readonly records: Attempt[]
  readonly provider: Provider
}
const observedUsage = (parsed: unknown) =>
  Effect.try({ try: () => usageOf(parsed), catch: () => fail('Bad usage') }).pipe(
    Effect.catchTag('BenchError', () => Effect.succeed(undefined)),
  )
const decode = (parsed: unknown, options: AttemptOptions, error: string | null) => {
  if (error !== null) return Effect.succeed({ answers: null, error })
  const { model, batch } = options
  return Effect.try({
    try: () =>
      decodeAnswers(
        model.arm === 'cheap-llm' ? chatAnswer(parsed) : parsed,
        packet(batch.fixtures, batch.selected).questions,
      ),
    catch: () => fail('Invalid answer'),
  }).pipe(
    Effect.map((answers) => ({ answers, error: null })),
    Effect.catchTag('BenchError', () => Effect.succeed({ answers: null, error: 'invalid-answer' })),
  )
}
export const executeAttempt = Effect.fn('decisions.attempt')(function* (options: AttemptOptions) {
  const { manifest, model, batch } = options
  const fs = yield* FileSystem.FileSystem
  const output = manifest.limits.perCallOutput
  const body = requestBody(batch, model, output)
  const input = new TextEncoder().encode(body).length + 256
  const denied = admission(manifest, options.records, model, input, output)
  if (denied !== null) return yield* fail('Admission stopped: ' + denied)
  const id = manifest.runId + '.' + String(options.records.filter((record) => record.phase === 'reserve').length + 1)
  const dir = join(options.dir, 'raw', id)
  yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 })
  yield* fs.writeFileString(join(dir, 'request.json'), body, { mode: 0o600, flag: 'wx' })
  const started: Attempt = {
    id,
    runId: manifest.runId,
    ...(manifest.campaign === undefined ? {} : { campaignId: manifest.campaign.id }),
    arm: batch.arm,
    fixtureId: batch.fixtures.map((fixture) => fixture.id).join(','),
    repetition: batch.repetition,
    phase: 'reserve',
    reservedInput: input,
    reservedOutput: output,
    input,
    output,
    costUsd: cost(model, input, output),
    status: 0,
    error: null,
    usageKnown: false,
    latencyMs: 0,
  }
  yield* appendJson(options.ledger, started)
  options.records.push(started)
  const reply = yield* options.provider({ model, body })
  yield* fs.writeFileString(join(dir, 'response.txt'), reply.text, { mode: 0o600, flag: 'wx' })
  const parsed = yield* parseJson(reply.text).pipe(Effect.catchTag('BenchError', () => Effect.succeed(undefined)))
  const observed = yield* observedUsage(parsed)
  const finished = settle(started, model, reply, observed)
  yield* appendJson(options.ledger, finished)
  options.records.push(finished)
  const { answers, error } = yield* decode(parsed, options, finished.error)
  const rows = modelRows(batch, {
    answers,
    error,
    latencyMs: reply.latencyMs,
    input: finished.input,
    output: finished.output,
    costUsd: finished.costUsd,
    actualCostUsd: model.priced && finished.usageKnown ? finished.costUsd : null,
  })
  yield* writeJson(join(dir, 'outcome.json'), { at: DateTime.formatIso(yield* DateTime.now), finished, error })
  return { rows, finished }
})
