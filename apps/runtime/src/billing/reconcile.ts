/** Current access is read from auth D1 on every admission; no stale entitlement cache or agent plan push. */
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { PRO, subscriptionAccessUntil } from './plans.ts'
import type { BillingStore } from './store.ts'
import type { BillingAccount, Subscription, WalletSubscription } from './schema.ts'
import type { DodoMode } from './dodo.ts'

export interface AccountPlan {
  readonly active: boolean
  /**
   * `free`: no Pro, and the deployment gives accounts a free plan (`FREE_DAILY_CREDITS`). `wallet`: Pro paid as a
   * signed USDC subscription in the Goblin Wallet (ADR 0054).
   */
  readonly source: 'override' | 'subscription' | 'wallet' | 'free' | 'none'
  readonly until: number | null
  /** The daily model allowance in estimated Token Plan Credits (ADR 0026). */
  readonly dailyCredits: number
  readonly status: string
  readonly hasCustomer: boolean
  readonly cancelAtPeriodEnd: boolean
}
/**
 * Until when a wallet subscription gives Pro (ADR 0054), or null: through the last period paid, and while a failed
 * renewal is retried, through its grace. A cancelled one runs to the end of what was paid; a lapsed one gives nothing.
 */
export const walletAccessUntil = (row: WalletSubscription, now: number): number | null => {
  const until =
    row.status === 'grace'
      ? Math.max(row.graceUntil ?? 0, row.paidThrough ?? 0)
      : row.status === 'lapsed'
        ? null
        : row.paidThrough
  return until !== null && until > now ? until : null
}

/** The status words a wallet subscription shows as: a renewal in grace is a payment past due. */
const WALLET_STATUS: Readonly<Record<WalletSubscription['status'], string>> = {
  pending: 'pending',
  active: 'active',
  grace: 'past_due',
  cancelled: 'cancelled',
  lapsed: 'expired',
}

/** Pro from the wallet, when its subscription gives access now. */
const walletPlan = (
  row: WalletSubscription | undefined,
  now: number,
  hasCustomer: boolean,
): AccountPlan | undefined => {
  const until = row === undefined ? null : walletAccessUntil(row, now)
  if (row === undefined || until === null) return undefined
  return {
    active: true,
    source: 'wallet',
    until,
    dailyCredits: PRO.dailyCredits,
    status: WALLET_STATUS[row.status],
    hasCustomer,
    cancelAtPeriodEnd: row.status === 'cancelled',
  }
}

/** What the account has on record: its billing account, its card subscriptions and its wallet subscription. */
interface Records {
  readonly account: BillingAccount | undefined
  readonly rows: readonly Subscription[]
  readonly wallet: WalletSubscription | undefined
}

const effectivePlan = ({ account, rows, wallet }: Records, stage: string, now: number, free: number): AccountPlan => {
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
  const fromWallet = active === undefined ? walletPlan(wallet, now, hasCustomer) : undefined
  if (fromWallet !== undefined) return fromWallet
  if (active === undefined)
    return {
      active: free > 0,
      source: free > 0 ? 'free' : 'none',
      until: null,
      dailyCredits: free,
      status: latest?.status ?? (free > 0 ? 'free' : 'unsubscribed'),
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
  /** Without `walletSubscription` (a store that predates ADR 0054), no wallet subscription counts. */
  store: Pick<BillingStore, 'account' | 'subscriptions'> & Partial<Pick<BillingStore, 'walletSubscription'>>,
  userId: string,
  stage: string,
  mode: DodoMode,
  /** `at`: the time to read it at (now). `free`: the deployment's free plan Credits (none). */
  { at, free = 0 }: { readonly at?: number | undefined; readonly free?: number } = {},
) {
  const now = at ?? (yield* Clock.currentTimeMillis)
  const account = yield* store.account(userId)
  const rows = yield* store.subscriptions(userId, mode)
  const wallet = store.walletSubscription === undefined ? undefined : yield* store.walletSubscription(userId)
  return effectivePlan({ account, rows, wallet }, stage, now, free)
})
