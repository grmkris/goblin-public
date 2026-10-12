// A merchant's subscription as the pages say it (ADR 0054): the four terms the owner signs, the line under its name,
// where Cancel sends them back, and whether their balance covers the first payment. Pure: a view in, words out.
import type { SubscriptionView, WalletStatusResult } from '@goblin/wallet/contract'
import { microsOf } from '../views/money.ts'

const DAY_MS = 86_400_000

const day = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
const fullDay = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/** "$10" for whole dollars, "$9.50" otherwise: a price, as the merchant's page says it. */
export const priceOf = (amountUsd: string): string => {
  const [whole = '0', cents = ''] = amountUsd.split('.')
  const fraction = cents.padEnd(2, '0').slice(0, 2)
  return fraction === '00' ? `$${whole}` : `$${whole}.${fraction}`
}

/** "goblin Pro". */
export const planName = (view: Pick<SubscriptionView, 'merchant'>): string => `${view.merchant} Pro`

/** One term of the delegation, in the owner's words: what the chain holds the merchant to. */
export interface SignedTerm {
  readonly id: 'token' | 'recipient' | 'amount' | 'until'
  readonly title: string
  readonly detail: string
}

/**
 * The four terms the chain enforces: USDC transfers only, only to the merchant's collector, at most the amount a
 * period, and for so many periods. Before it is signed, the dates are counted from `now`.
 */
export function termsOf(view: SubscriptionView, now: number = Date.now()): readonly SignedTerm[] {
  const starts = view.startsAt === undefined ? now : Date.parse(view.startsAt)
  const second = new Date(starts + view.periodDays * DAY_MS).toISOString()
  const ends = view.expiresAt ?? new Date(starts + view.months * view.periodDays * DAY_MS).toISOString()
  return [
    { id: 'token', title: 'USDC transfers only', detail: 'Nothing else can move from your account.' },
    { id: 'recipient', title: `Only to ${view.merchant}`, detail: 'The recipient is fixed; it cannot be changed.' },
    {
      id: 'amount',
      title: `At most ${priceOf(view.amountUsd)} every ${String(view.periodDays)} days`,
      detail: `The first payment right after you sign, the next from ${day(second)}.`,
    },
    {
      id: 'until',
      title: `For ${String(view.months)} payments`,
      detail: `Until ${fullDay(ends)}, or until you cancel.`,
    },
  ]
}

/** "$10 at most every 30 days". */
export const capLine = (view: SubscriptionView): string =>
  `${priceOf(view.amountUsd)} at most every ${String(view.periodDays)} days`

/** Where a subscription stands, in a line: paid through a date, cancelled with Pro running on, or ended. */
export function standingOf(view: SubscriptionView, now: number = Date.now()): string {
  const through = view.paidThrough === undefined ? undefined : Date.parse(view.paidThrough)
  if (view.status === 'revoked')
    return through !== undefined && through > now
      ? `Cancelled. ${planName(view)} runs to ${day(view.paidThrough ?? '')}.`
      : 'Cancelled.'
  if (view.status === 'expired') return 'Ended.'
  if (through === undefined) return 'Waiting for the first payment.'
  return through > now ? `Paid through ${day(view.paidThrough ?? '')}` : 'Payment due'
}

/** The subscriptions worth a row: active ones, and cancelled ones whose paid period has not ended. */
export const shownSubscriptions = (
  views: readonly SubscriptionView[],
  now: number = Date.now(),
): readonly SubscriptionView[] =>
  views.filter(
    (view) =>
      view.status === 'active' ||
      (view.status === 'revoked' && view.paidThrough !== undefined && Date.parse(view.paidThrough) > now),
  )

/** Where Cancel on the sign page sends the owner: back to the merchant's page, saying nothing was signed. */
export function declinedUrl(view: SubscriptionView): string {
  const url = new URL(view.returnUrl)
  url.searchParams.set('declined', '1')
  return url.href
}

/** The merchant's own site, for a request that ran out: the owner asks it again from there. */
export const merchantSite = (view: SubscriptionView): string => new URL(view.returnUrl).origin

/**
 * What the owner's own account on Base lacks for the first payment, in micro-dollars: 0 when it covers it, undefined
 * when the balance could not be read.
 */
export function shortfallOf(view: SubscriptionView, status: WalletStatusResult | undefined): bigint | undefined {
  const row = status?.balances.find(
    (balance) => balance.chain === 'base' && balance.holder === 'owner' && balance.symbol === 'USDC',
  )
  if (row === undefined) return undefined
  const short = microsOf(view.amountUsd) - microsOf(row.balance)
  return short > 0n ? short : 0n
}
