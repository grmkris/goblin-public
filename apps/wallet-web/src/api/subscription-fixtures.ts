// goblin Pro in the demo (ADR 0054): a request waiting at /subscribe/<id>, and in a busy wallet one already signed and
// paid for its first period. The fixture signer turns a request into a subscription, and a cancellation revokes it.
import type { SubscriptionView } from '@goblin/wallet/contract'
import { OWNER } from './fixtures.ts'

/** The request the demo signs: open `/subscribe/sub_<32 hex>?fixtures`. */
export const SUBSCRIPTION_REQUEST_ID = `sub_${'5ab0'.repeat(8)}`
const ACTIVE_ID = `sub_${'c0ffee00'.repeat(4)}`
const COLLECTOR = '0x8F3a1b2C4d5E6f708192A3b4C5d6E7f8091Ac41D'
const DAY_MS = 86_400_000

const iso = (ms: number): string => new Date(ms).toISOString()

const base = (id: string, now: number): SubscriptionView => ({
  id,
  merchant: 'goblin',
  merchantHost: 'goblin.surf',
  plan: 'pro',
  amountUsd: '10.00',
  periodDays: 30,
  months: 12,
  chain: 'base',
  collector: COLLECTOR,
  status: 'pending',
  returnUrl: `https://goblin.surf/subscribe/done?subscription=${id}`,
  requestExpiresAt: iso(now + 3_600_000),
})

/** A signed subscription whose first period started `daysAgo` days ago and is paid. */
const signed = (view: SubscriptionView, now: number, daysAgo: number): SubscriptionView => {
  const starts = now - daysAgo * DAY_MS
  return {
    ...view,
    status: 'active',
    startsAt: iso(starts),
    expiresAt: iso(starts + view.months * view.periodDays * DAY_MS),
    paidThrough: iso(starts + view.periodDays * DAY_MS),
    lastPaidAt: iso(starts),
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

/** The demo's subscriptions: a request to sign, and in a busy wallet goblin Pro already running. */
export const fixtureSubscriptions = (busy: boolean, now = Date.now()): SubscriptionView[] => [
  base(SUBSCRIPTION_REQUEST_ID, now),
  ...(busy ? [signed(base(ACTIVE_ID, now), now, 4)] : []),
]

/** What signing does to a request: active from now, the first $10 taken. */
export const signedNow = (view: SubscriptionView, now = Date.now()): SubscriptionView => signed(view, now, 0)
