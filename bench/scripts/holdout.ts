import { DateTime, Effect, Schema } from 'effect'
import { join } from 'node:path'
import { episodes } from '../src/plan.ts'
import type { Resolved } from '../src/results.ts'
import { digest } from './identity.ts'
import { appendJson, readLedger, fail } from './store.ts'

const Receipt = Schema.Struct({
  runId: Schema.String,
  manifestHash: Schema.String,
  sourceHash: Schema.String,
  at: Schema.String,
  families: Schema.Array(Schema.String),
  probes: Schema.Array(Schema.String),
})
/** Reserve a held-out trial once. Resumption retains the same reservation and cannot hide a previous exposure. */
export const admitHoldout = Effect.fn('bench.holdout')(function* (root: string, resolved: Resolved) {
  if (resolved.manifest.split !== 'held-out') return
  const path = join(root, '.local/bench/holdout-consumption.jsonl')
  const prior = yield* readLedger(path, Receipt)
  const manifestHash = digest(resolved.manifest)
  if (prior.some((receipt) => receipt.runId === resolved.runId)) return
  if (prior.some((receipt) => receipt.manifestHash === manifestHash))
    return yield* fail('This held-out experiment was already admitted; resume its original run instead')
  const at = yield* DateTime.now
  yield* appendJson(path, {
    runId: resolved.runId,
    manifestHash,
    sourceHash: resolved.sourceHash,
    at: DateTime.formatIso(at),
    families: resolved.manifest.scenarioIds,
    probes: [...new Set(episodes(resolved.manifest).map((episode) => episode.probe.id))],
  })
})
