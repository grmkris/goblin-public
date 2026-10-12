// goblin Pro in the demo (ADR 0054), billed both ways: requests waiting at /subscribe/<id> for a monthly subscription
// and for a day pass, and in a busy wallet both already signed: the monthly one paid for its first period, the day pass
// used today. The fixture signer turns a request into a subscription, and a cancellation revokes it.
import type { MerchantBilling, SubscriptionView } from '@goblin/wallet/contract'
import { periodCount, subscriptionStart } from '@goblin/wallet/delegation'
import { OWNER } from './fixtures.ts'

/** The requests the demo signs: open `/subscribe/sub_<32 hex>?fixtures` with either id. */
export const SUBSCRIPTION_REQUEST_ID = `sub_${'5ab0'.repeat(8)}`
export const DAY_PASS_REQUEST_ID = `sub_${'0da7'.repeat(8)}`
const ACTIVE_ID = `sub_${'c0ffee00'.repeat(4)}`
const ACTIVE_DAY_ID = `sub_${'da7e0000'.repeat(4)}`
const COLLECTOR = '0x8F3a1b2C4d5E6f708192A3b4C5d6E7f8091Ac41D'
const DAY_MS = 86_400_000

const iso = (ms: number): string => new Date(ms).toISOString()

/** goblin's prices: a $1 day pass, or $15 every 30 days; either for twelve months. */
const PRICES: Readonly<Record<MerchantBilling, { readonly amountUsd: string; readonly periodDays: number }>> = {
  day: { amountUsd: '1.00', periodDays: 1 },
  month: { amountUsd: '15.00', periodDays: 30 },
}

const base = (id: string, billing: MerchantBilling, now: number): SubscriptionView => ({
  id,
  merchant: 'goblin',
  merchantHost: 'goblin.surf',
  plan: 'pro',
  billing,
  ...PRICES[billing],
  months: 12,
  chain: 'base',
  collector: COLLECTOR,
  status: 'pending',
  returnUrl: `https://goblin.surf/subscribe/success?subscription=${id}`,
  requestExpiresAt: iso(now + 3_600_000),
})

/** A payment the demo has taken: its period (1-based) and when. */
interface Paid {
  readonly period: number
  readonly at: number
}

/** A request signed `daysAgo` days ago, as the wallet keeps it: periods from then (a day pass's from that UTC midnight). */
const signed = (view: SubscriptionView, now: number, daysAgo: number, paid?: Paid): SubscriptionView => {
  const starts = subscriptionStart(view, Math.floor((now - daysAgo * DAY_MS) / 1000)) * 1000
  const period = view.periodDays * DAY_MS
  return {
    ...view,
    status: 'active',
    startsAt: iso(starts),
    expiresAt: iso(starts + periodCount(view) * period),
    ...(paid === undefined ? {} : { paidThrough: iso(starts + paid.period * period), lastPaidAt: iso(paid.at) }),
    delegation: {
      delegate: view.collector,
      delegator: OWNER,
      authority: `0x${'f'.repeat(64)}`,
      caveats: [],
      salt: '1',
      signature: `0x${'ab'.repeat(65)}`,
    },
  }
}

/** A day pass signed nine days ago and used today: today's UTC day is its tenth period, paid at the first message. */
const usedToday = (view: SubscriptionView, now: number): SubscriptionView => {
  const today = subscriptionStart(view, Math.floor(now / 1000)) * 1000
  return signed(view, now, 9, { period: 10, at: Math.max(today, now - 600_000) })
}

/** The demo's subscriptions: a request of each billing to sign, and in a busy wallet both already running. */
export const fixtureSubscriptions = (busy: boolean, now = Date.now()): SubscriptionView[] => [
  base(SUBSCRIPTION_REQUEST_ID, 'month', now),
  base(DAY_PASS_REQUEST_ID, 'day', now),
  ...(busy
    ? [
        signed(base(ACTIVE_ID, 'month', now), now, 4, { period: 1, at: now - 4 * DAY_MS }),
        usedToday(base(ACTIVE_DAY_ID, 'day', now), now),
      ]
    : []),
]

/**
 * What signing does to a request: active from now. A monthly subscription's first payment is taken at once; a day
 * pass takes nothing until goblin is used.
 */
export const signedNow = (view: SubscriptionView, now = Date.now()): SubscriptionView =>
  signed(view, now, 0, view.billing === 'day' ? undefined : { period: 1, at: now })
