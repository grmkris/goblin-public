/** Bounded billing retries, provider readback and payload pruning. */
import { Clock, Effect } from 'effect'
import { processStored, upsertSubscription, type BillingDeps } from './events.ts'
export const runBillingCron = Effect.fn('billing.cron')(function* (deps: BillingDeps | undefined) {
  if (deps === undefined) return
  const now = yield* Clock.currentTimeMillis
  for (const row of yield* deps.store.retryable(deps.dodo.mode, now))
    yield* processStored(deps, row.id).pipe(Effect.ignoreCause)
  for (const row of yield* deps.store.dueSubscriptions(deps.dodo.mode, now))
    yield* deps.dodo.getSubscription(row.id).pipe(
      Effect.flatMap((fresh) => upsertSubscription(deps, fresh, now)),
      Effect.ignoreCause,
    )
  yield* deps.store.prune(now)
})
