/** Bounded billing retries, provider readback and payload pruning; and the wallet subscriptions' renewals (ADR 0054). */
import { Clock, Effect } from 'effect'
import { reportAndRecover } from '../observability/report.ts'
import { processStored, upsertSubscription, type BillingDeps } from './events.ts'
import { runWalletRenewals, type WalletBillingDeps } from './renewals.ts'
import { WalletMerchant, type WalletMerchantApi } from './wallet.ts'

/** The hourly renewals of goblin Pro paid from the Goblin Wallet, where the deployment sells it. */
export const runWalletCron = (
  wallet: { readonly deps: WalletBillingDeps; readonly merchant: WalletMerchantApi } | undefined,
) =>
  wallet === undefined
    ? Effect.void
    : runWalletRenewals(wallet.deps).pipe(
        Effect.provideService(WalletMerchant, wallet.merchant),
        reportAndRecover('billing.walletCron', undefined),
      )
export const runBillingCron = Effect.fn('billing.cron')(function* (deps: BillingDeps | undefined) {
  if (deps === undefined) return
  const now = yield* Clock.currentTimeMillis
  for (const row of yield* deps.store.retryable(deps.dodo.mode, now))
    yield* processStored(deps, row.id).pipe(reportAndRecover('billing.cron.retry', undefined))
  for (const row of yield* deps.store.dueSubscriptions(deps.dodo.mode, now))
    yield* deps.dodo.getSubscription(row.id).pipe(
      Effect.flatMap((fresh) => upsertSubscription(deps, fresh, now)),
      reportAndRecover('billing.cron.readback', undefined),
    )
  yield* deps.store.prune(now)
})
