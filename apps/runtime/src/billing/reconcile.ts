/** Current access is read from auth D1 on every admission; no stale entitlement cache or agent plan push. */
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { PRO, subscriptionAccessUntil } from './plans.ts'
import type { BillingStore } from './store.ts'
import type { BillingAccount, Subscription } from './schema.ts'
import type { DodoMode } from './dodo.ts'

export interface AccountPlan {
  readonly active: boolean
  readonly source: 'override' | 'subscription' | 'none'
  readonly until: number | null
  /** The daily model allowance in estimated Token Plan Credits (ADR 0026). */
  readonly dailyCredits: number
  readonly status: string
  readonly hasCustomer: boolean
  readonly cancelAtPeriodEnd: boolean
}
const effectivePlan = (
  account: BillingAccount | undefined,
  rows: readonly Subscription[],
  stage: string,
  now: number,
): AccountPlan => {
  const hasCustomer = account?.customerId != null
  if (account?.planOverride === 'pro' && (account.overrideStage === null || account.overrideStage === stage))
    return {
      active: true,
      source: 'override',
      until: null,
      dailyCredits: account.dailyCredits ?? PRO.dailyCredits,
      status: 'operator override',
      hasCustomer,
      cancelAtPeriodEnd: false,
    }
  const active = rows
    .filter((row) => subscriptionAccessUntil(row, now) !== null)
    .toSorted((a, b) => (subscriptionAccessUntil(b, now) ?? 0) - (subscriptionAccessUntil(a, now) ?? 0))[0]
  const latest = rows.toSorted((a, b) => b.providerUpdatedAt - a.providerUpdatedAt)[0]
  if (active === undefined)
    return {
      active: false,
      source: 'none',
      until: null,
      dailyCredits: 0,
      status: latest?.status ?? 'unsubscribed',
      hasCustomer,
      cancelAtPeriodEnd: latest?.cancelAtPeriodEnd === 1,
    }
  return {
    active: true,
    source: 'subscription',
    until: subscriptionAccessUntil(active, now),
    dailyCredits: PRO.dailyCredits,
    status: active.status,
    hasCustomer,
    cancelAtPeriodEnd: active.cancelAtPeriodEnd === 1,
  }
}
export const planOf = Effect.fn('billing.planOf')(function* (
  store: BillingStore,
  userId: string,
  stage: string,
  mode: DodoMode,
  at?: number,
) {
  const now = at ?? (yield* Clock.currentTimeMillis)
  const account = yield* store.account(userId)
  const rows = yield* store.subscriptions(userId, mode)
  return effectivePlan(account, rows, stage, now)
})
