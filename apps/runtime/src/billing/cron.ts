/** Adapted from myapps@8a69ec64: bounded retries, provider readback and payload pruning. Admission handles expiry. */
import { Clock, Effect } from 'effect'
import { processStored, upsertSubscription, type BillingDeps } from './events.ts'
import { pruneWorkspaceAccess } from '../workspaces/maintenance.ts'
export const runBillingCron = Effect.fn('billing.cron')(function* (
  deps: BillingDeps | undefined,
  database: D1Database,
) {
  const now = yield* Clock.currentTimeMillis
  yield* pruneWorkspaceAccess(database, now)
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
