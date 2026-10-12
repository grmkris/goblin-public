// A merchant's subscription as the pages say it (ADR 0054): how it bills, the four terms the owner signs, the line
// under its name, where Cancel sends them back, and whether their balance covers the first payment. A day pass
// (`billing: 'day'`) is taken only on days the owner uses the merchant, a UTC day at a time; a month every
// `periodDays` days. Pure: a view in, words out.
import type { MerchantBilling, SubscriptionView, WalletStatusResult } from '@goblin/wallet/contract'
import { periodCount, subscriptionStart } from '@goblin/wallet/delegation'
import { formatUsd } from '../ui/format.ts'
import { microsOf } from '../views/money.ts'

const DAY_MS = 86_400_000

const day = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
const fullDay = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
/** A day pass runs to the end of a UTC day: when that is on the owner's own clock, "02:00". */
const time = (iso: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/** "$10" for whole dollars, "$9.50" otherwise: a price, as the merchant's page says it. */
export const priceOf = (amountUsd: string): string => {
  const [whole = '0', cents = ''] = amountUsd.split('.')
  const fraction = cents.padEnd(2, '0').slice(0, 2)
  return fraction === '00' ? `$${whole}` : `$${whole}.${fraction}`
}

/** "goblin Pro". */
export const planName = (view: Pick<SubscriptionView, 'merchant'>): string => `${view.merchant} Pro`

/** What a subscription bills, as its price reads after the amount. */
export interface Billing {
  readonly merchant: string
  readonly billing: MerchantBilling
  readonly amountUsd: string
  readonly periodDays: number
}

/** "a day you use goblin" or "every 30 days": the words after the price. */
export const billingTail = (view: Billing): string =>
  view.billing === 'day' ? `a day you use ${view.merchant}` : `every ${String(view.periodDays)} days`

/** "$1.00 a day you use goblin" or "$15.00 every 30 days". */
export const billingLine = (view: Billing): string => `${formatUsd(view.amountUsd)} ${billingTail(view)}`

/** "goblin Pro · $1.00 a day you use goblin": the subscription in one line, as the signing screen titles it. */
export const offerLine = (view: Billing): string => `${planName(view)} · ${billingLine(view)}`

/** One term of the delegation, in the owner's words: what the chain holds the merchant to. */
export interface SignedTerm {
  readonly id: 'token' | 'recipient' | 'amount' | 'until'
  readonly title: string
  readonly detail: string
}

/** The amount a period, as the chain caps it, in the owner's words. */
function amountTerm(view: SubscriptionView, starts: number): SignedTerm {
  if (view.billing === 'day')
    return {
      id: 'amount',
      title: `At most ${priceOf(view.amountUsd)} a day`,
      detail: `${view.merchant} takes it only on days you use it. A day runs midnight to midnight UTC.`,
    }
  const second = new Date(starts + view.periodDays * DAY_MS).toISOString()
  return {
    id: 'amount',
    title: `At most ${priceOf(view.amountUsd)} every ${String(view.periodDays)} days`,
    detail: `The first payment right after you sign, the next from ${day(second)}.`,
  }
}

/**
 * The four terms the chain enforces: USDC transfers only, only to the merchant's collector, at most the amount a
 * period (a UTC day for a day pass), and until the last period ends. Before it is signed, the dates are counted from
 * `now`, as the wallet will prepare them.
 */
export function termsOf(view: SubscriptionView, now: number = Date.now()): readonly SignedTerm[] {
  const starts =
    view.startsAt === undefined ? subscriptionStart(view, Math.floor(now / 1000)) * 1000 : Date.parse(view.startsAt)
  const ends = view.expiresAt ?? new Date(starts + periodCount(view) * view.periodDays * DAY_MS).toISOString()
  return [
    { id: 'token', title: 'USDC transfers only', detail: 'Nothing else can move from your account.' },
    { id: 'recipient', title: `Only to ${view.merchant}`, detail: 'The recipient is fixed; it cannot be changed.' },
    amountTerm(view, starts),
    {
      id: 'until',
      title: view.billing === 'day' ? `For ${String(view.months)} months` : `For ${String(periodCount(view))} payments`,
      detail: `Until ${fullDay(ends)}, or until you cancel.`,
    },
  ]
}

/** The end of the period paid, while it lasts: a time for a day pass (it ends with the UTC day), a date otherwise. */
function paidUntil(view: SubscriptionView, now: number): { readonly time: string; readonly date: string } | undefined {
  const { paidThrough } = view
  if (paidThrough === undefined || Date.parse(paidThrough) <= now) return undefined
  return { time: time(paidThrough), date: day(paidThrough) }
}

/** Where an active subscription stands: paid for now, or for a day pass when it was last used, or waiting or due. */
function activeStanding(view: SubscriptionView, now: number): string {
  const until = paidUntil(view, now)
  if (until !== undefined) return view.billing === 'day' ? `Paid until ${until.time}` : `Paid through ${until.date}`
  if (view.billing === 'day')
    return view.lastPaidAt === undefined ? 'Nothing taken yet' : `Last paid ${day(view.lastPaidAt)}`
  return view.paidThrough === undefined ? 'Waiting for the first payment.' : 'Payment due'
}

/**
 * Where a subscription stands, in a line: paid for now, cancelled with Pro running on, or ended. A day pass is paid
 * until the end of the UTC day it was last used, and owes nothing on a day it is not.
 */
export function standingOf(view: SubscriptionView, now: number = Date.now()): string {
  if (view.status === 'revoked') {
    const until = paidUntil(view, now)
    if (until === undefined) return 'Cancelled.'
    return `Cancelled. ${planName(view)} runs ${view.billing === 'day' ? `until ${until.time}` : `to ${until.date}`}.`
  }
  if (view.status === 'expired') return 'Ended.'
  return activeStanding(view, now)
}

/** What cancelling leaves: Pro until the paid period ends, nothing taken after it, and the gas of the cancellation. */
export function cancelText(view: SubscriptionView, now: number = Date.now()): string {
  const until = paidUntil(view, now)
  const left =
    until === undefined
      ? 'Nothing more is taken.'
      : view.billing === 'day'
        ? `${planName(view)} runs until ${until.time}, the end of the day you paid for.`
        : `${planName(view)} runs to ${until.date}, the end of the period you paid for.`
  return `${left} You sign one operation from your account; its gas, a few cents, is paid in USDC.`
}

/** The sign page's note when the owner's USDC on Base does not cover the first payment, short by `short`. */
export function firstPaymentNote(view: SubscriptionView, short: string): { title: string; text: string } {
  return view.billing === 'day'
    ? {
        title: `Add ${short} for your first day`,
        text: `${view.merchant} takes ${priceOf(view.amountUsd)} the first time you use it each day, from your USDC on Base. You can sign now and add it after.`,
      }
    : {
        title: `Add ${short} for the first payment`,
        text: `${view.merchant} takes the first ${priceOf(view.amountUsd)} right after you sign, from your USDC on Base. You can sign now and add it after.`,
      }
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
