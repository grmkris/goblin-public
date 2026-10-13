/**
 * goblin Pro paid as a signed USDC subscription (ADR 0054), started and confirmed here, and renewed here when it is
 * monthly. The owner signs it once in the Goblin Wallet. Monthly: goblin takes the first period's payment when they
 * come back, then one payment each period from the hourly cron. Three days before a payment goblin reminds them (with
 * what their wallet lacks, if anything); a failed payment is retried each day through a seven-day grace, after which
 * the account has no plan; a subscription the owner revoked in the wallet runs to the end of what was paid. A day pass
 * is paid as it is used (`day-pass.ts`). The chain caps every payment, whatever this code does.
 */
import type { BillingId } from '@goblin/contracts'
import type { BillingNotice } from '@goblin/contracts/internal'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { reportAndRecover } from '../observability/report.ts'
import { confirmDayPass } from './day-pass.ts'
import {
  DAY_MS,
  EXPLORER,
  PAYMENT_REFUSAL,
  PENDING_RETRY_MS,
  afterPaid,
  newSubscription,
  operationOf,
  periodAt,
  receiptOf,
  referenceOf,
} from './periods.ts'
import type { PlanCatalog } from './plans.ts'
import { planOf } from './reconcile.ts'
import type { WalletSubscription } from './schema.ts'
import type { BillingStore } from './store.ts'
import { WalletMerchant, type WalletSubscriptionView } from './wallet.ts'

/** How long a failed monthly renewal is retried before the account has no plan. */
export const GRACE_MS = 7 * DAY_MS
/** How long before a monthly payment the owner is reminded of it. */
export const REMIND_MS = 3 * DAY_MS

export interface WalletBillingDeps {
  readonly store: Pick<
    BillingStore,
    | 'account'
    | 'subscriptions'
    | 'walletSubscriptions'
    | 'writeWalletSubscription'
    | 'supersedeWalletSubscriptions'
    | 'dueWalletSubscriptions'
    | 'checkoutCount'
    | 'recordCheckout'
  >
  /** goblin's own origin: where the wallet sends the owner back. */
  readonly appUrl: string
  /** The deployment's prices: what a new subscription asks the owner to sign. */
  readonly catalog: PlanCatalog
  /** Tells the owner, in Personal, Activity and Telegram, once per notice id. */
  readonly notify: (userId: string, notice: BillingNotice) => Effect.Effect<void>
}

const shortDate = (ms: number): string =>
  new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const price = (amountUsd: string): string => `$${amountUsd.replace(/\.00?$/u, '')}`

/**
 * A failed monthly payment. Revoked or ended in the wallet: nothing more is taken, Pro runs to what was paid. Otherwise
 * the grace starts (from the end of the paid period, or for a first payment from when it was signed) and the payment is
 * tried again each day; past the grace it lapses, and the account has no plan.
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
    body: 'Once the paid period ends, goblin stops answering until you subscribe again: a day pass or monthly.',
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
  const collection = yield* merchant.collect(row.subscriptionId, { period, operationId: operationOf(row, period) })
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
  // The first payment makes this the account's plan: a day pass it replaces stops being collected.
  if (collection.status === 'paid' && row.period === 0)
    yield* deps.store.supersedeWalletSubscriptions(row.userId, row.subscriptionId, now)
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

/** One monthly subscription's turn of the cron: a reminder when a payment is near, the payment when it is due. */
const renew = Effect.fn('billing.walletRenew')(function* (deps: WalletBillingDeps, row: WalletSubscription) {
  const now = yield* Clock.currentTimeMillis
  if (row.nextAttemptAt === null || row.billing !== 'month') return
  if (now < row.nextAttemptAt) {
    if (row.status === 'active' && row.remindedPeriod <= row.period) yield* remind(deps, row)
    return
  }
  yield* collect(deps, row, row.status === 'pending' ? periodAt(row, now) : row.period + 1)
})

/** The hourly cron's share: every monthly subscription with a payment due or near, each on its own. */
export const runWalletRenewals = Effect.fn('billing.walletRenewals')(function* (deps: WalletBillingDeps) {
  const now = yield* Clock.currentTimeMillis
  for (const row of yield* deps.store.dueWalletSubscriptions(now + REMIND_MS))
    yield* renew(deps, row).pipe(reportAndRecover('billing.walletRenew', undefined))
})

/** A path of this app to come back to: absolute, not protocol-relative, short; anything else is `/`. */
const returnPath = (value: string | undefined): string =>
  value !== undefined && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : '/'

/**
 * Asks the wallet for Pro as a subscription the owner signs once, paid by `billing` (the day pass or monthly) at the
 * deployment's price, coming back to `/subscribe/success` and then `back`. An account that has Pro is refused, except
 * a day pass moving to monthly; so is a sixth request within a minute.
 */
export const startWalletSubscription = Effect.fn('billing.walletStart')(function* (
  deps: WalletBillingDeps,
  userId: string,
  { back, stage, billing }: { readonly back: string | undefined; readonly stage: string; readonly billing: BillingId },
) {
  const now = yield* Clock.currentTimeMillis
  const plan = yield* planOf(deps.store, userId, stage, stage === 'prod' ? 'live_mode' : 'test_mode', {
    at: now,
    catalog: deps.catalog,
  })
  if (plan.active && !(plan.billing === 'day' && billing === 'month')) return { error: 'already_subscribed' } as const
  if ((yield* deps.store.checkoutCount(userId, now - 60_000)) >= 5) return { error: 'checkout_limit' } as const
  const target = new URL('/subscribe/success', deps.appUrl)
  target.searchParams.set('return', returnPath(back))
  const created = yield* (yield* WalletMerchant).create({
    offer: deps.catalog[billing],
    reference: referenceOf(userId),
    returnUrl: target.href,
  })
  yield* deps.store.recordCheckout(created.id, userId, now)
  return { signUrl: created.signUrl } as const
})

/**
 * The owner came back from signing a monthly subscription: it must be active. Its current period's payment is taken
 * once (a repeat answers the same receipt) and Pro starts; a payment still landing answers `pending`, and the cron
 * finishes it.
 */
const confirmMonthly = Effect.fn('billing.confirmMonthly')(function* (
  deps: WalletBillingDeps,
  userId: string,
  view: WalletSubscriptionView,
  existing: WalletSubscription | undefined,
) {
  if (existing !== undefined && existing.period > 0) return { receipt: receiptOf(existing) } as const
  if (view.status === 'pending') return { error: 'subscription_unsigned' } as const
  const { startsAt } = view
  if (view.status !== 'active' || startsAt === undefined) return { error: 'subscription_ended' } as const
  const now = yield* Clock.currentTimeMillis
  const row = existing ?? newSubscription(userId, { ...view, startsAt }, 'pending', now)
  const { row: after, collection } = yield* collect(deps, row, periodAt(row, now))
  if (collection.status === 'failed') return { error: PAYMENT_REFUSAL[collection.reason ?? 'chain'] } as const
  return { receipt: receiptOf(after) } as const
})

/**
 * The owner came back from signing (or from adding funds for a day pass): the subscription must be the wallet's and
 * theirs. A monthly one takes its first payment; a day pass turns on (`confirmDayPass`).
 */
export const confirmWalletSubscription = Effect.fn('billing.walletConfirm')(function* (
  deps: WalletBillingDeps,
  userId: string,
  subscriptionId: string,
) {
  const view = yield* (yield* WalletMerchant).get(subscriptionId)
  if (view.reference !== referenceOf(userId)) return { error: 'subscription_unknown' } as const
  const existing = (yield* deps.store.walletSubscriptions(userId)).find((row) => row.subscriptionId === subscriptionId)
  return view.billing === 'day'
    ? yield* confirmDayPass(deps.store, userId, view, existing)
    : yield* confirmMonthly(deps, userId, view, existing)
})
