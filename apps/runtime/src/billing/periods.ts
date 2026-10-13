/**
 * A wallet subscription's periods and payments in goblin's terms (ADR 0054), pure over its row: which period a time
 * falls in, when one ends, what a paid one leaves, and its receipt. Monthly periods run `periodDays` days from when the
 * owner signed; a day pass's run from midnight UTC, so its period is the UTC day.
 */
import type { WalletReceipt } from '@goblin/contracts'
import type { WalletSubscription } from './schema.ts'
import type { WalletCollection, WalletSubscriptionView } from './wallet.ts'

export const DAY_MS = 86_400_000
/** A payment still landing is asked about again after this. */
export const PENDING_RETRY_MS = 3_600_000
/** Base's explorer: the wallet collects on Base. */
export const EXPLORER = 'https://basescan.org/tx/'

/** How goblin names an account to the wallet. */
export const referenceOf = (userId: string): string => `goblin:${userId}`

/** A period's payment: the same each retry, so the wallet takes it once (it takes a period once whatever this says). */
export const operationOf = (row: Pick<WalletSubscription, 'billing' | 'subscriptionId'>, period: number): string =>
  `${row.billing}:${row.subscriptionId}:${String(period)}`

const periodMs = (row: Pick<WalletSubscription, 'periodDays'>): number => row.periodDays * DAY_MS
/** The UTC day a time falls in, counted from the epoch. */
const utcDay = (ms: number): number => Math.floor(ms / DAY_MS)

type Periodic = Pick<WalletSubscription, 'billing' | 'periodDays' | 'startsAt'>

/** The period (1-based) `now` falls in: for a day pass, the UTC days since the one it starts on, plus one. */
export const periodAt = (row: Periodic, now: number): number =>
  Math.max(
    1,
    row.billing === 'day'
      ? Math.floor((utcDay(now) - utcDay(row.startsAt)) / row.periodDays) + 1
      : Math.floor((now - row.startsAt) / periodMs(row)) + 1,
  )

/** When period `period` ends, as the next one starts: for a day pass, midnight UTC. */
export const throughOf = (row: Periodic, period: number): number =>
  row.billing === 'day'
    ? (utcDay(row.startsAt) + period * row.periodDays) * DAY_MS
    : row.startsAt + period * periodMs(row)

/**
 * A paid period: the subscription runs through its end. A monthly one's next payment is due then; a day pass has no
 * next payment until the owner uses goblin again.
 */
export const afterPaid = (
  row: WalletSubscription,
  period: number,
  collection: WalletCollection,
  now: number,
): WalletSubscription => {
  const through = throughOf(row, period)
  const cancelled = row.status === 'cancelled'
  return {
    ...row,
    status: cancelled ? 'cancelled' : 'active',
    period,
    paidThrough: through,
    nextAttemptAt: cancelled || row.billing === 'day' ? null : through,
    graceUntil: null,
    lastOperation: operationOf(row, period),
    lastTx: collection.txHash ?? null,
    lastFailure: null,
    updatedAt: now,
  }
}

/** The account's row for a subscription the wallet says is signed and theirs, nothing paid from it yet. */
export const newSubscription = (
  userId: string,
  view: WalletSubscriptionView & { readonly startsAt: string },
  status: 'pending' | 'active',
  now: number,
): WalletSubscription => ({
  subscriptionId: view.id,
  userId,
  billing: view.billing,
  status,
  amountUsd: view.amountUsd,
  periodDays: view.periodDays,
  startsAt: Date.parse(view.startsAt),
  period: 0,
  paidThrough: null,
  nextAttemptAt: status === 'pending' ? now + PENDING_RETRY_MS : null,
  graceUntil: null,
  remindedPeriod: 0,
  lastOperation: null,
  lastTx: null,
  lastFailure: null,
  createdAt: now,
  updatedAt: now,
})

/**
 * The receipt of the row's last paid period, as the return page shows it. A day pass is `paid` while it is on, even
 * before its first day is taken (`paidFrom` and `paidThrough` null then).
 */
export const receiptOf = (row: WalletSubscription): WalletReceipt => ({
  status: (row.billing === 'day' ? row.status === 'active' : row.period > 0) ? 'paid' : 'pending',
  amountUsd: row.amountUsd,
  periodDays: row.periodDays,
  paidFrom: row.period > 0 ? throughOf(row, row.period - 1) : null,
  paidThrough: row.paidThrough,
  ...(row.lastTx === null ? {} : { explorerUrl: `${EXPLORER}${row.lastTx}` }),
})

/** The refusal a first payment that failed answers as (and a day pass's day after funds were added). */
export const PAYMENT_REFUSAL = {
  insufficient_funds: 'payment_short',
  revoked: 'subscription_ended',
  expired: 'subscription_ended',
  not_due: 'payment_failed',
  chain: 'payment_failed',
} as const
