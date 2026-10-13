/** Current access is read from auth D1 on every admission; no stale entitlement cache or agent plan push. */
import type { BillingId } from '@goblin/contracts'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { DEFAULT_CATALOG, type PlanCatalog, subscriptionAccessUntil } from './plans.ts'
import type { BillingStore } from './store.ts'
import type { BillingAccount, Subscription, WalletSubscription } from './schema.ts'
import type { DodoMode } from './dodo.ts'

/**
 * The account's plan, as every gate reads it. There is one plan, goblin Pro, and no free one (ADR 0054, amended
 * 2026-10-13): `active` and `plan: 'pro'` go together, and an account without them is refused chat.
 */
export interface AccountPlan {
  readonly active: boolean
  /** goblin Pro, however it is paid; null without a plan. */
  readonly plan: 'pro' | null
  /** An operator's override, a card subscription, Pro paid from the Goblin Wallet (ADR 0054), or none. */
  readonly source: 'override' | 'subscription' | 'wallet' | 'none'
  /** How Pro from the wallet is paid: the day pass, or monthly; null for any other source. */
  readonly billing: BillingId | null
  /** Until when the plan is paid for, or null when it runs on without a date (an override, an active day pass). */
  readonly until: number | null
  /** The daily model allowance in estimated Token Plan Credits (ADR 0026). */
  readonly dailyCredits: number
  readonly status: string
  readonly hasCustomer: boolean
  readonly cancelAtPeriodEnd: boolean
}

/**
 * Whether a wallet subscription gives Pro now, and until when (null: no date). Monthly: through the last period paid,
 * and while a failed renewal is retried, through its grace; a cancelled one runs to the end of what was paid. A day
 * pass: while it is active, whatever day it is (the first message of each day pays for it); cancelled, to the end of
 * the last day paid; one whose day could not be paid gives nothing until the owner pays that day.
 */
export const walletAccess = (row: WalletSubscription, now: number): { readonly until: number | null } | undefined => {
  if (row.status === 'superseded' || row.status === 'lapsed' || row.status === 'pending') return undefined
  if (row.billing === 'day' && row.status === 'active') return { until: null }
  const until = row.status === 'grace' ? Math.max(row.graceUntil ?? 0, row.paidThrough ?? 0) : row.paidThrough
  return until !== null && until > now ? { until } : undefined
}

/** The status words a wallet subscription shows as: a renewal in grace is a payment past due. */
const WALLET_STATUS: Readonly<Record<WalletSubscription['status'], string>> = {
  pending: 'pending',
  active: 'active',
  grace: 'past_due',
  cancelled: 'cancelled',
  lapsed: 'expired',
  superseded: 'superseded',
}

/** The subscription the account's Pro comes from now: one that gives access, monthly before a day pass. */
export const payingSubscription = (rows: readonly WalletSubscription[], now: number): WalletSubscription | undefined =>
  rows
    .filter((row) => walletAccess(row, now) !== undefined)
    .toSorted((a, b) => (a.billing === b.billing ? b.createdAt - a.createdAt : a.billing === 'month' ? -1 : 1))[0]

/**
 * The subscription Settings shows: the one Pro comes from, else the newest that was not superseded (a payment that
 * failed, a day pass waiting for funds, one that ended).
 */
export const shownSubscription = (rows: readonly WalletSubscription[], now: number): WalletSubscription | undefined =>
  payingSubscription(rows, now) ??
  rows.filter((row) => row.status !== 'superseded').toSorted((a, b) => b.createdAt - a.createdAt)[0]

/** Pro from the wallet, when one of its subscriptions gives access now. */
const walletPlan = (
  rows: readonly WalletSubscription[],
  now: number,
  hasCustomer: boolean,
  catalog: PlanCatalog,
): AccountPlan | undefined => {
  const row = payingSubscription(rows, now)
  const access = row === undefined ? undefined : walletAccess(row, now)
  if (row === undefined || access === undefined) return undefined
  return {
    active: true,
    plan: 'pro',
    source: 'wallet',
    billing: row.billing,
    until: access.until,
    dailyCredits: catalog[row.billing].dailyCredits,
    status: WALLET_STATUS[row.status],
    hasCustomer,
    cancelAtPeriodEnd: row.status === 'cancelled',
  }
}

/** What the account has on record: its billing account, its card subscriptions and its wallet subscriptions. */
interface Records {
  readonly account: BillingAccount | undefined
  readonly rows: readonly Subscription[]
  readonly wallet: readonly WalletSubscription[]
}

const effectivePlan = (
  { account, rows, wallet }: Records,
  stage: string,
  now: number,
  catalog: PlanCatalog,
): AccountPlan => {
  const hasCustomer = account?.customerId != null
  if (account?.planOverride === 'pro' && (account.overrideStage === null || account.overrideStage === stage))
    return {
      active: true,
      plan: 'pro',
      source: 'override',
      billing: null,
      until: null,
      dailyCredits: account.dailyCredits ?? catalog.month.dailyCredits,
      status: 'operator override',
      hasCustomer,
      cancelAtPeriodEnd: false,
    }
  const active = rows
    .filter((row) => subscriptionAccessUntil(row, now) !== null)
    .toSorted((a, b) => (subscriptionAccessUntil(b, now) ?? 0) - (subscriptionAccessUntil(a, now) ?? 0))[0]
  if (active !== undefined)
    return {
      active: true,
      plan: 'pro',
      source: 'subscription',
      billing: null,
      until: subscriptionAccessUntil(active, now),
      dailyCredits: catalog.month.dailyCredits,
      status: active.status,
      hasCustomer,
      cancelAtPeriodEnd: active.cancelAtPeriodEnd === 1,
    }
  const fromWallet = walletPlan(wallet, now, hasCustomer, catalog)
  if (fromWallet !== undefined) return fromWallet
  const latest = rows.toSorted((a, b) => b.providerUpdatedAt - a.providerUpdatedAt)[0]
  return {
    active: false,
    plan: null,
    source: 'none',
    billing: null,
    until: null,
    dailyCredits: 0,
    status: latest?.status ?? 'unsubscribed',
    hasCustomer,
    cancelAtPeriodEnd: latest?.cancelAtPeriodEnd === 1,
  }
}
export const planOf = Effect.fn('billing.planOf')(function* (
  /** Without `walletSubscriptions` (a store that predates ADR 0054), no wallet subscription counts. */
  store: Pick<BillingStore, 'account' | 'subscriptions'> & Partial<Pick<BillingStore, 'walletSubscriptions'>>,
  userId: string,
  stage: string,
  mode: DodoMode,
  /** `at`: the time to read it at (now). `catalog`: the deployment's prices and Credits (the defaults). */
  { at, catalog = DEFAULT_CATALOG }: { readonly at?: number | undefined; readonly catalog?: PlanCatalog } = {},
) {
  const now = at ?? (yield* Clock.currentTimeMillis)
  const account = yield* store.account(userId)
  const rows = yield* store.subscriptions(userId, mode)
  const wallet = store.walletSubscriptions === undefined ? [] : yield* store.walletSubscriptions(userId)
  return effectivePlan({ account, rows, wallet }, stage, now, catalog)
})
