import { Effect } from 'effect'
import { join } from 'node:path'
import { appendJson, fail, lockRun, readLedger } from './store.ts'
import { Attempt } from '../src/decisions/schema.ts'

export interface SettlementOptions {
  readonly root: string
  readonly runId: string
  readonly attemptId: string
  readonly ownerApproved: string | undefined
}

/** An explicit owner approval releases admission while retaining the entire unknown-usage reservation. */
export const settleUnfinished = Effect.fn('decisions.settleUnfinished')(function* (options: SettlementOptions) {
  const { ownerApproved, runId, attemptId } = options
  if (ownerApproved === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(ownerApproved))
    return yield* fail('Settlement requires --owner-approved YYYY-MM-DD')
  if (!/^[a-z0-9_-]+$/u.test(runId)) return yield* fail('Invalid run id')
  yield* lockRun(options.root)
  const path = join(options.root, 'attempts.jsonl')
  const records = yield* readLedger(path, Attempt)
  const matching = records.filter((record) => record.id === attemptId && record.runId === runId)
  const started = matching.find((record) => record.phase === 'reserve')
  if (started === undefined) return yield* fail('Unknown attempt')
  if (matching.some((record) => record.phase === 'settle')) return yield* fail('Attempt is already settled')
  const finished: Attempt = {
    ...started,
    phase: 'settle',
    input: started.reservedInput,
    output: started.reservedOutput,
    usageKnown: false,
    ownerApproved,
    error: 'owner-approved-unfinished',
  }
  yield* appendJson(path, finished)
  return finished
})
