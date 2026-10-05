/** Adapted from myapps@8a69ec64: bounded retries, provider readback and payload pruning. Admission handles expiry. */
import { Clock, Effect } from 'effect'
import { processStored, upsertSubscription, type BillingDeps } from './events.ts'
import { pruneWorkspaceAccess } from '../workspaces/maintenance.ts'
import { retryMemberInvalidations } from '../workspaces/invalidation.ts'
import type { RuntimeEnv } from '../env.ts'
import { toAppError } from '../http/errors.ts'
export const runBillingCron = Effect.fn('billing.cron')(function* (
  deps: BillingDeps | undefined,
  database: D1Database,
  agents?: RuntimeEnv['AGENTS'],
) {
  const now = yield* Clock.currentTimeMillis
  yield* pruneWorkspaceAccess(database, now)
  if (agents !== undefined)
    yield* Effect.tryPromise({
      try: () => retryMemberInvalidations({ AUTH_DB: database, AGENTS: agents }),
      catch: toAppError,
    }).pipe(Effect.ignoreCause)
  if (deps === undefined) return
  for (const row of yield* deps.store.retryable(deps.dodo.mode, now))
    yield* processStored(deps, row.id).pipe(Effect.ignoreCause)
  for (const row of yield* deps.store.dueSubscriptions(deps.dodo.mode, now))
    yield* deps.dodo.getSubscription(row.id).pipe(
      Effect.flatMap((fresh) => upsertSubscription(deps, fresh, now)),
      Effect.ignoreCause,
    )
  yield* deps.store.prune(now)
})
