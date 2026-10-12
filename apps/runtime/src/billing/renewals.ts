/**
 * goblin Pro paid as a signed USDC subscription (ADR 0054). The owner signs it once in the Goblin Wallet; goblin takes
 * the first period's payment when they come back, then one payment each period from the hourly cron. Three days
 * before a payment goblin reminds them (with what their wallet lacks, if anything); a failed payment is retried each
 * day through a seven-day grace, after which the account falls back to free; a subscription the owner revoked in the
 * wallet runs to the end of what was paid. The chain caps every payment, whatever this code does.
 */
import type { WalletReceipt } from '@goblin/contracts'
import type { BillingNotice } from '@goblin/contracts/internal'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { reportAndRecover } from '../observability/report.ts'
import { planOf } from './reconcile.ts'
import type { WalletSubscription } from './schema.ts'
import type { BillingStore } from './store.ts'
import { type WalletCollection, WalletMerchant, type WalletSubscriptionView } from './wallet.ts'

const DAY_MS = 86_400_000
/** How long a failed renewal is retried before the account falls back to free. */
export const GRACE_MS = 7 * DAY_MS
/** How long before a payment the owner is reminded of it. */
export const REMIND_MS = 3 * DAY_MS
/** A payment still landing is asked about again after this. */
const PENDING_RETRY_MS = 3_600_000
/** Base's explorer: the wallet collects on Base. */
const EXPLORER = 'https://basescan.org/tx/'

export interface WalletBillingDeps {
  readonly store: Pick<
    BillingStore,
    | 'account'
    | 'subscriptions'
    | 'walletSubscription'
    | 'writeWalletSubscription'
    | 'dueWalletSubscriptions'
    | 'checkoutCount'
    | 'recordCheckout'
  >
  /** goblin's own origin: where the wallet sends the owner back. */
  readonly appUrl: string
  /** Tells the owner, in Personal, Activity and Telegram, once per notice id. */
  readonly notify: (userId: string, notice: BillingNotice) => Effect.Effect<void>
}

/** How goblin names an account to the wallet, and a period's payment: the same each retry, so the wallet pays it once. */
export const referenceOf = (userId: string): string => `goblin:${userId}`
export const operationOf = (userId: string, period: number): string => `pro:${userId}:${String(period)}`

const periodMs = (row: Pick<WalletSubscription, 'periodDays'>): number => row.periodDays * DAY_MS
const throughOf = (row: WalletSubscription, period: number): number => row.startsAt + period * periodMs(row)
/** The period (1-based) `now` falls in. */
const periodAt = (row: WalletSubscription, now: number): number =>
  Math.max(1, Math.floor((now - row.startsAt) / periodMs(row)) + 1)

const shortDate = (ms: number): string =>
  new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const price = (amountUsd: string): string => `$${amountUsd.replace(/\.00?$/u, '')}`

/** A paid period: the subscription runs through its end, and the next payment is due then. */
export const afterPaid = (
  row: WalletSubscription,
  period: number,
  collection: WalletCollection,
  now: number,
): WalletSubscription => {
  const through = throughOf(row, period)
  return {
    ...row,
    status: row.status === 'cancelled' ? 'cancelled' : 'active',
    period,
    paidThrough: through,
    nextAttemptAt: row.status === 'cancelled' ? null : through,
    graceUntil: null,
    lastOperation: operationOf(row.userId, period),
    lastTx: collection.txHash ?? null,
    lastFailure: null,
    updatedAt: now,
  }
}

/**
 * A failed payment. Revoked or ended in the wallet: nothing more is taken, Pro runs to what was paid. Otherwise the
 * grace starts (from the end of the paid period, or for a first payment from when it was signed) and the payment is
 * tried again each day; past the grace the account lapses to free.
 */
export const afterFailed = (row: WalletSubscription, reason: string, now: number): WalletSubscription => {
  if (reason === 'revoked' || reason === 'expired')
    return {
      ...row,
      status: row.period > 0 ? 'cancelled' : 'lapsed',
      nextAttemptAt: null,
      graceUntil: null,
      lastFailure: reason,
      updatedAt: now,
    }
  if (reason === 'not_due')
    return { ...row, nextAttemptAt: now + PENDING_RETRY_MS, lastFailure: reason, updatedAt: now }
  const graceUntil = row.graceUntil ?? (row.paidThrough ?? row.createdAt) + GRACE_MS
  if (now >= graceUntil) return { ...row, status: 'lapsed', nextAttemptAt: null, lastFailure: reason, updatedAt: now }
  return {
    ...row,
    status: row.status === 'pending' ? 'pending' : 'grace',
    graceUntil,
    nextAttemptAt: Math.min(now + DAY_MS, graceUntil),
    lastFailure: reason,
    updatedAt: now,
  }
}

/** The receipt of the row's last paid period, as the return page shows it. */
export const receiptOf = (row: WalletSubscription): WalletReceipt => ({
  status: row.period > 0 ? 'paid' : 'pending',
  amountUsd: row.amountUsd,
  periodDays: row.periodDays,
  paidFrom: row.period > 0 ? throughOf(row, row.period - 1) : null,
  paidThrough: row.paidThrough,
  ...(row.lastTx === null ? {} : { explorerUrl: `${EXPLORER}${row.lastTx}` }),
})

/** Where the owner adds funds in their wallet. */
const addFundsUrl = (origin: string): string => `${origin}/add-funds`

/** The notices, in goblin's words: one id per subscription, kind and period, so each is posted once. */
const notices = {
  paid: (row: WalletSubscription): BillingNotice => ({
    id: `billing:${row.subscriptionId}:paid:${String(row.period)}`,
    title: `Paid ${price(row.amountUsd)} for goblin Pro from your Goblin Wallet`,
    body: `Pro runs through ${shortDate(row.paidThrough ?? row.updatedAt)}.`,
    ...(row.lastTx === null ? {} : { url: `${EXPLORER}${row.lastTx}` }),
  }),
  remind: (row: WalletSubscription, origin: string, short: string | undefined): BillingNotice => ({
    id: `billing:${row.subscriptionId}:remind:${String(row.period + 1)}`,
    title: `goblin Pro renews on ${shortDate(row.nextAttemptAt ?? row.updatedAt)}: ${price(row.amountUsd)} from your Goblin Wallet`,
    ...(short === undefined || short === '0'
      ? {}
      : { body: `Your wallet is ${price(short)} short. Add it before then.`, url: addFundsUrl(origin) }),
  }),
  failed: (row: WalletSubscription, origin: string, short: string | undefined): BillingNotice => ({
    id: `billing:${row.subscriptionId}:failed:${String(row.period + 1)}`,
    title: `goblin could not take ${price(row.amountUsd)} for Pro`,
    body:
      short === undefined || short === '0'
        ? `It tries again each day until ${shortDate(row.graceUntil ?? row.updatedAt)}.`
        : `Your Goblin Wallet is ${price(short)} short. Add it by ${shortDate(row.graceUntil ?? row.updatedAt)}, or Pro ends then.`,
    url: addFundsUrl(origin),
  }),
  ended: (row: WalletSubscription, appUrl: string): BillingNotice => ({
    id: `billing:${row.subscriptionId}:ended`,
    title:
      row.status === 'cancelled'
        ? 'goblin Pro is cancelled; nothing more is taken from your wallet'
        : 'goblin Pro has ended: the payment did not go through',
    body: 'Your account is on the free plan once the paid period ends. Subscribe again any time.',
    url: new URL('/subscribe', appUrl).href,
  }),
}

/** What the owner's wallet lacks for a payment, when the wallet can say; never a failure. */
const shortOf = (subscriptionId: string) =>
  WalletMerchant.use((merchant) => merchant.get(subscriptionId)).pipe(
    Effect.map((view) => view.shortUsd),
    // expected: a wallet that does not answer leaves "Add $X" out of the notice; the notice still goes.
    Effect.orElseSucceed(() => undefined),
  )

/** Takes period `period`'s payment and records what happened, telling the owner where it matters. */
const collect = Effect.fn('billing.walletCollect')(function* (
  deps: WalletBillingDeps,
  row: WalletSubscription,
  period: number,
) {
  const merchant = yield* WalletMerchant
  const collection = yield* merchant.collect(row.subscriptionId, {
    period,
    operationId: operationOf(row.userId, period),
  })
  const now = yield* Clock.currentTimeMillis
  if (collection.status === 'pending') {
    const waiting = { ...row, nextAttemptAt: now + PENDING_RETRY_MS, updatedAt: now }
    yield* deps.store.writeWalletSubscription(waiting)
    return { row: waiting, collection }
  }
  const next =
    collection.status === 'paid'
      ? afterPaid(row, period, collection, now)
      : afterFailed(row, collection.reason ?? 'chain', now)
  yield* deps.store.writeWalletSubscription(next)
  if (collection.status === 'paid') yield* deps.notify(row.userId, notices.paid(next))
  else if (next.status === 'lapsed' || next.status === 'cancelled')
    yield* deps.notify(row.userId, notices.ended(next, deps.appUrl))
  else if (row.graceUntil === null && next.graceUntil !== null)
    yield* deps.notify(row.userId, notices.failed(next, merchant.origin, yield* shortOf(row.subscriptionId)))
  return { row: next, collection }
})

/** Three days before a payment, once: the owner learns when and how much, and what their wallet lacks. */
const remind = Effect.fn('billing.walletRemind')(function* (deps: WalletBillingDeps, row: WalletSubscription) {
  const merchant = yield* WalletMerchant
  const view: WalletSubscriptionView | undefined = yield* merchant.get(row.subscriptionId).pipe(
    // expected: a wallet that does not answer still gets its reminder, without "Add $X".
    Effect.orElseSucceed(() => undefined),
  )
  const now = yield* Clock.currentTimeMillis
  if (view?.status === 'revoked') {
    const cancelled = { ...row, status: 'cancelled' as const, nextAttemptAt: null, updatedAt: now }
    yield* deps.store.writeWalletSubscription(cancelled)
    return yield* deps.notify(row.userId, notices.ended(cancelled, deps.appUrl))
  }
  yield* deps.store.writeWalletSubscription({ ...row, remindedPeriod: row.period + 1, updatedAt: now })
  yield* deps.notify(row.userId, notices.remind(row, merchant.origin, view?.shortUsd))
})

/** One subscription's turn of the cron: a reminder when a payment is near, the payment when it is due. */
const renew = Effect.fn('billing.walletRenew')(function* (deps: WalletBillingDeps, row: WalletSubscription) {
  const now = yield* Clock.currentTimeMillis
  if (row.nextAttemptAt === null) return
  if (now < row.nextAttemptAt) {
    if (row.status === 'active' && row.remindedPeriod <= row.period) yield* remind(deps, row)
    return
  }
  yield* collect(deps, row, row.status === 'pending' ? periodAt(row, now) : row.period + 1)
})

/** The hourly cron's share: every subscription with a payment due or near, each on its own. */
export const runWalletRenewals = Effect.fn('billing.walletRenewals')(function* (deps: WalletBillingDeps) {
  const now = yield* Clock.currentTimeMillis
  for (const row of yield* deps.store.dueWalletSubscriptions(now + REMIND_MS))
    yield* renew(deps, row).pipe(reportAndRecover('billing.walletRenew', undefined))
})

/** A path of this app to come back to: absolute, not protocol-relative, short; anything else is `/`. */
const returnPath = (value: string | undefined): string =>
  value !== undefined && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : '/'

/**
 * Asks the wallet for a Pro subscription the owner signs once, coming back to `/subscribe/success` and then `back`.
 * An account that has Pro already is refused, as is a sixth request within a minute.
 */
export const startWalletSubscription = Effect.fn('billing.walletStart')(function* (
  deps: WalletBillingDeps,
  userId: string,
  { back, stage }: { readonly back: string | undefined; readonly stage: string },
) {
  const now = yield* Clock.currentTimeMillis
  const plan = yield* planOf(deps.store, userId, stage, stage === 'prod' ? 'live_mode' : 'test_mode', { at: now })
  if (plan.active && plan.source !== 'free') return { error: 'already_subscribed' } as const
  if ((yield* deps.store.checkoutCount(userId, now - 60_000)) >= 5) return { error: 'checkout_limit' } as const
  const target = new URL('/subscribe/success', deps.appUrl)
  target.searchParams.set('return', returnPath(back))
  const created = yield* (yield* WalletMerchant).create({ reference: referenceOf(userId), returnUrl: target.href })
  yield* deps.store.recordCheckout(created.id, userId, now)
  return { signUrl: created.signUrl } as const
})

/** The account's row for a subscription the wallet says is active and theirs: kept, or new and unpaid. */
const rowFor = (
  existing: WalletSubscription | undefined,
  userId: string,
  view: WalletSubscriptionView & { readonly startsAt: string },
  now: number,
): WalletSubscription =>
  existing?.subscriptionId === view.id
    ? existing
    : {
        userId,
        subscriptionId: view.id,
        status: 'pending',
        amountUsd: view.amountUsd,
        periodDays: view.periodDays,
        startsAt: Date.parse(view.startsAt),
        period: 0,
        paidThrough: null,
        nextAttemptAt: now + PENDING_RETRY_MS,
        graceUntil: null,
        remindedPeriod: 0,
        lastOperation: null,
        lastTx: null,
        lastFailure: null,
        createdAt: now,
        updatedAt: now,
      }

/** The refusal a failed first payment answers as. */
const FIRST_PAYMENT_REFUSAL = {
  insufficient_funds: 'payment_short',
  revoked: 'subscription_ended',
  expired: 'subscription_ended',
  not_due: 'payment_failed',
  chain: 'payment_failed',
} as const

/**
 * The owner came back from signing: the subscription must be the wallet's, theirs and active. Its current period's
 * payment is taken once (a repeat answers the same receipt) and Pro starts; a payment still landing answers `pending`,
 * and the cron finishes it.
 */
export const confirmWalletSubscription = Effect.fn('billing.walletConfirm')(function* (
  deps: WalletBillingDeps,
  userId: string,
  subscriptionId: string,
) {
  const view = yield* (yield* WalletMerchant).get(subscriptionId)
  if (view.reference !== referenceOf(userId)) return { error: 'subscription_unknown' } as const
  const existing = yield* deps.store.walletSubscription(userId)
  if (existing?.subscriptionId === subscriptionId && existing.period > 0)
    return { receipt: receiptOf(existing) } as const
  if (view.status === 'pending') return { error: 'subscription_unsigned' } as const
  const { startsAt } = view
  if (view.status !== 'active' || startsAt === undefined) return { error: 'subscription_ended' } as const
  const now = yield* Clock.currentTimeMillis
  const row = rowFor(existing, userId, { ...view, startsAt }, now)
  const { row: after, collection } = yield* collect(deps, row, periodAt(row, now))
  if (collection.status === 'failed') return { error: FIRST_PAYMENT_REFUSAL[collection.reason ?? 'chain'] } as const
  return { receipt: receiptOf(after) } as const
})
