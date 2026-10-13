/**
 * The day pass (ADR 0054, amended 2026-10-13): goblin Pro paid on each UTC day the owner uses goblin. The owner signs
 * it once; confirming it turns Pro on and takes nothing. The first message of a UTC day takes that day's payment, in
 * the background, so the answer never waits for it; an idle day costs nothing, and no cron pulls. A day that cannot be
 * paid (the wallet short, the pass revoked or run out) ends Pro from the next message on, with no reminder and no
 * grace. The owner adds funds and confirms the pass again, which takes that day's payment.
 */
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { afterPaid, newSubscription, operationOf, periodAt, receiptOf } from './periods.ts'
import type { WalletSubscription } from './schema.ts'
import type { BillingStore } from './store.ts'
import { type WalletCollection, WalletMerchant, type WalletSubscriptionView } from './wallet.ts'

/** What a day's payment came to: `settled` (paid, or nothing to pay), `ended` (Pro is off), or `retry` next message. */
export type DayOutcome = 'settled' | 'ended' | 'retry'

type DayStore = Pick<BillingStore, 'walletSubscriptions' | 'writeWalletSubscription' | 'supersedeWalletSubscriptions'>

/**
 * A day the wallet did not pay. Short of funds, the pass lapses until the owner adds them; revoked or past its last
 * day, it is cancelled and runs to the end of the last day paid. Anything else (the chain, the wallet) leaves it on, and
 * the next message tries again.
 */
export const afterDayFailed = (row: WalletSubscription, reason: string, now: number): WalletSubscription => {
  if (reason === 'insufficient_funds') return { ...row, status: 'lapsed', lastFailure: reason, updatedAt: now }
  if (reason === 'revoked' || reason === 'expired')
    return { ...row, status: 'cancelled', nextAttemptAt: null, lastFailure: reason, updatedAt: now }
  return { ...row, lastFailure: reason, updatedAt: now }
}

/** Whether the pass itself has ended in the wallet: revoked, or past its last day. A wallet that does not say is no. */
const passEnded = (subscriptionId: string) =>
  WalletMerchant.use((merchant) => merchant.get(subscriptionId)).pipe(
    Effect.map((view) => view.status === 'revoked' || view.status === 'expired'),
    // expected: a pass the wallet cannot read now is tried again with the next message, never ended on a guess.
    Effect.orElseSucceed(() => false),
  )

/**
 * The day `now` falls in, paid once: a day already paid takes nothing. A payment still landing changes nothing (the
 * wallet answers the same period again); the outcome is kept otherwise.
 */
const collectDay = Effect.fn('billing.collectDay')(function* (store: DayStore, row: WalletSubscription, now: number) {
  const period = periodAt(row, now)
  if (row.period >= period) return { row, collection: undefined }
  const collection: WalletCollection = yield* (yield* WalletMerchant).collect(row.subscriptionId, {
    period,
    operationId: operationOf(row, period),
  })
  if (collection.status === 'pending') return { row, collection }
  const at = yield* Clock.currentTimeMillis
  const reason = collection.reason ?? 'chain'
  // `expired` is also a day that ended unpaid (a message just before midnight): only the pass's own end ends it.
  const ended = reason !== 'expired' || (yield* passEnded(row.subscriptionId))
  const next =
    collection.status === 'paid'
      ? afterPaid(row, period, collection, at)
      : afterDayFailed(row, ended ? reason : 'chain', at)
  yield* store.writeWalletSubscription(next)
  return { row: next, collection }
})

/**
 * An owner's message was admitted (turn admission, ADR 0054): on the account's day pass, takes today's payment unless
 * it is paid. The caller runs this in the background and only once a day.
 */
export const payToday = Effect.fn('billing.payToday')(function* (store: DayStore, userId: string) {
  const row = (yield* store.walletSubscriptions(userId)).find(
    (each) => each.billing === 'day' && each.status === 'active',
  )
  if (row === undefined) return 'settled' satisfies DayOutcome
  const { row: after, collection } = yield* collectDay(store, row, yield* Clock.currentTimeMillis)
  if (collection === undefined || collection.status === 'paid') return 'settled' satisfies DayOutcome
  return after.status === 'active' ? ('retry' satisfies DayOutcome) : ('ended' satisfies DayOutcome)
})

/** Whether the wallet says the owner's account lacks a day's payment now. */
const short = (view: WalletSubscriptionView): boolean => view.shortUsd !== undefined && Number(view.shortUsd) > 0

/**
 * A pass whose day it could not pay, confirmed again once the owner added funds: it takes that day's payment, and the
 * pass is on again once it is paid. Still short, or failing, it says so and stays off.
 */
const retakeDay = Effect.fn('billing.retakeDay')(function* (store: DayStore, lapsed: WalletSubscription, now: number) {
  const { row, collection } = yield* collectDay(store, lapsed, now)
  if (collection?.status === 'failed') {
    if (row.status === 'cancelled') return { error: 'subscription_ended' } as const
    return { error: collection.reason === 'insufficient_funds' ? 'payment_short' : 'payment_failed' } as const
  }
  if (collection?.status === 'pending') return { receipt: receiptOf(row) } as const
  // Paid now, or the day was paid already: the pass is on again.
  const on = row.status === 'active' ? row : { ...row, status: 'active' as const, lastFailure: null, updatedAt: now }
  if (on !== row) yield* store.writeWalletSubscription(on)
  return { receipt: receiptOf(on) } as const
})

/**
 * Confirming a day pass (`walletConfirm`). The first time, Pro is on and nothing is taken, unless the wallet already
 * lacks a day's payment, which it says rather than give a day it cannot take. After a day the pass could not pay, it
 * takes that day's payment (`retakeDay`). A pass that is on answers its receipt again.
 */
export const confirmDayPass = Effect.fn('billing.confirmDayPass')(function* (
  store: DayStore,
  userId: string,
  view: WalletSubscriptionView,
  existing: WalletSubscription | undefined,
) {
  if (existing?.status === 'active') return { receipt: receiptOf(existing) } as const
  if (view.status === 'pending') return { error: 'subscription_unsigned' } as const
  const { startsAt } = view
  if (view.status !== 'active' || startsAt === undefined) return { error: 'subscription_ended' } as const
  const now = yield* Clock.currentTimeMillis
  if (existing !== undefined)
    return existing.status === 'lapsed'
      ? yield* retakeDay(store, existing, now)
      : ({ error: 'subscription_ended' } as const)
  if (short(view)) return { error: 'payment_short' } as const
  const row = newSubscription(userId, { ...view, startsAt }, 'active', now)
  yield* store.writeWalletSubscription(row)
  yield* store.supersedeWalletSubscriptions(userId, row.subscriptionId, now)
  return { receipt: receiptOf(row) } as const
})
