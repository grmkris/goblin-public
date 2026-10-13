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

/** "Day pass" or "Monthly": how goblin names the two ways to pay for Pro. */
export const billingName = (billing: MerchantBilling): string => (billing === 'day' ? 'Day pass' : 'Monthly')

/** "goblin Pro · Day pass": a collected payment's title in Activity. */
export const paymentTitle = (payment: Pick<Billing, 'merchant' | 'billing'>): string =>
  `${planName(payment)} · ${billingName(payment.billing)}`

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

/** A moment on the owner's clock (or `timeZone`'s, in tests): its calendar day, and whether it is that day's start. */
function localParts(ms: number, timeZone: string | undefined): { readonly day: string; readonly midnight: boolean } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(ms)
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((each) => each.type === type)?.value ?? ''
  return {
    day: `${part('year')}-${part('month')}-${part('day')}`,
    midnight: part('hour') === '00' && part('minute') === '00',
  }
}

/** The day `ms` falls on, said from `now` on the owner's clock: "today", "tomorrow", or its date, "14 Oct". */
function dayFrom(ms: number, now: number, timeZone: string | undefined): string {
  const { day: target } = localParts(ms, timeZone)
  if (target === localParts(now, timeZone).day) return 'today'
  if (target === localParts(now + DAY_MS, timeZone).day) return 'tomorrow'
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone })
}

/** "today", "tomorrow" or "on 14 Oct", after a time. */
const onDay = (when: string): string => (when === 'today' || when === 'tomorrow' ? when : `on ${when}`)

/**
 * When the paid period ends, while it lasts: a date for a month; for a day pass, which runs to midnight UTC, the
 * owner's own day when that is where their day ends too (on UTC time), else their local time and day ("02:00
 * tomorrow", "20:00 today"), never a bare time that reads as their own midnight.
 */
type PaidEnd =
  | { readonly kind: 'date'; readonly date: string }
  | { readonly kind: 'day'; readonly day: string }
  | { readonly kind: 'time'; readonly at: string }

function paidEnd(view: SubscriptionView, now: number, timeZone: string | undefined): PaidEnd | undefined {
  const { paidThrough } = view
  const end = paidThrough === undefined ? Number.NaN : Date.parse(paidThrough)
  if (paidThrough === undefined || !(end > now)) return undefined
  if (view.billing !== 'day') return { kind: 'date', date: day(paidThrough) }
  if (localParts(end, timeZone).midnight) return { kind: 'day', day: dayFrom(end - 1, now, timeZone) }
  const clock = new Date(end).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone })
  return { kind: 'time', at: `${clock} ${onDay(dayFrom(end, now, timeZone))}` }
}

/** "Paid through 8 Nov", "Paid for today" or "Paid until 02:00 tomorrow". */
function paidLine(end: PaidEnd): string {
  if (end.kind === 'date') return `Paid through ${end.date}`
  if (end.kind === 'day') return end.day === 'today' ? 'Paid for today' : `Paid through ${end.day}`
  return `Paid until ${end.at}`
}

/** How long Pro runs on once cancelled: "to 8 Nov", "to the end of today" or "until 02:00 tomorrow". */
function runsLine(end: PaidEnd): string {
  if (end.kind === 'date') return `to ${end.date}`
  if (end.kind === 'day') return `to the end of ${end.day}`
  return `until ${end.at}`
}

/** Where an active subscription stands: paid for now, or for a day pass when it was last used, or waiting or due. */
function activeStanding(view: SubscriptionView, now: number, timeZone: string | undefined): string {
  const end = paidEnd(view, now, timeZone)
  if (end !== undefined) return paidLine(end)
  if (view.billing === 'day')
    return view.lastPaidAt === undefined ? 'Nothing taken yet' : `Last paid ${day(view.lastPaidAt)}`
  return view.paidThrough === undefined ? 'Waiting for the first payment.' : 'Payment due'
}

/**
 * Where a subscription stands, in a line: paid for now, cancelled with Pro running on, or ended. A day pass is paid
 * until the end of the UTC day it was last used, and owes nothing on a day it is not. `timeZone` is the owner's own
 * unless a test names one.
 */
export function standingOf(view: SubscriptionView, now: number = Date.now(), timeZone?: string): string {
  if (view.status === 'revoked') {
    const end = paidEnd(view, now, timeZone)
    return end === undefined ? 'Cancelled.' : `Cancelled. ${planName(view)} runs ${runsLine(end)}.`
  }
  if (view.status === 'expired') return 'Ended.'
  return activeStanding(view, now, timeZone)
}

/** What cancelling leaves: Pro until the paid period ends, nothing taken after it, and the gas of the cancellation. */
export function cancelText(view: SubscriptionView, now: number = Date.now(), timeZone?: string): string {
  const end = paidEnd(view, now, timeZone)
  const left =
    end === undefined
      ? 'Nothing more is taken.'
      : end.kind === 'date'
        ? `${planName(view)} runs ${runsLine(end)}, the end of the period you paid for.`
        : end.kind === 'day'
          ? `${planName(view)} runs ${runsLine(end)}, the day you paid for.`
          : `${planName(view)} runs ${runsLine(end)}, when the day you paid for ends at midnight UTC.`
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
