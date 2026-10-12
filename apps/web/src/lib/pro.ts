// goblin Pro and the two ways to pay for it from the Goblin Wallet (ADR 0054, amended 2026-10-13): the day pass and
// monthly, priced by the deployment (`BillingState.catalog`). What `/subscribe`, its return page, Settings' plan card,
// the upgrade prompt and the composer say about them, in one place; the pages only lay it out.
import type { BillingId, BillingState, PlanOffer, ServerView, WalletPlan, WalletStatus } from '@goblin/contracts'
import { dayAndMonth, shortDate } from './format.ts'

/** Whole cents of a decimal dollar string or number; anything unreadable is none. */
const centsOf = (amount: string | number): number | undefined => {
  const value = Number(amount)
  return Number.isFinite(value) ? Math.round(value * 100) : undefined
}

/** A price as the pages write it: "$1", "$15", "$9.50". */
export const usd = (amount: string | number): string => {
  const cents = centsOf(amount) ?? 0
  return cents % 100 === 0 ? `$${String(cents / 100)}` : `$${(cents / 100).toFixed(2)}`
}

/** A balance, always with its cents and never rounded up: "$152.60", "$0.99". */
export const held = (dollars: number): string => `$${(Math.floor(dollars * 100 + 1e-6) / 100).toFixed(2)}`

/** The way to pay `id`, as the deployment prices it. */
export const offerOf = (catalog: BillingState['catalog'], id: BillingId): PlanOffer | undefined =>
  catalog.find((offer) => offer.id === id)

/** A way to pay in the owner's words: its name, its price and what that price is for, and who it suits. */
export interface Choice {
  readonly name: string
  readonly price: string
  readonly per: string
  readonly suits: string
}

export const choiceOf = (offer: PlanOffer): Choice =>
  offer.id === 'day'
    ? { name: 'Day pass', price: usd(offer.amountUsd), per: 'a day you use goblin', suits: 'Nothing on idle days.' }
    : {
        name: 'Monthly',
        price: usd(offer.amountUsd),
        per: `every ${String(offer.periodDays)} days`,
        suits: 'Best if you use goblin most days.',
      }

/** Pro's prices in one phrase, day pass first: "$1 a day you use goblin, or $15 every 30 days". */
export const pricesOf = (catalog: BillingState['catalog']): string =>
  catalog
    .map((offer) => {
      const choice = choiceOf(offer)
      return `${choice.price} ${choice.per}`
    })
    .join(', or ')

/** What Pro costs, as one sentence for the upgrade prompt and the composer. */
export const proPrices = (catalog: BillingState['catalog']): string =>
  catalog.length === 0
    ? 'Pro is paid in USDC from your Goblin Wallet.'
    : `Pro is ${pricesOf(catalog)}, paid in USDC from your Goblin Wallet.`

/** Pro's daily model Credits, as the catalog gives them. */
export const creditsOf = (catalog: BillingState['catalog']): number | undefined => catalog[0]?.dailyCredits

/** The owner's connected Goblin Wallet (its first-class profile, ADR 0043); none until one is connected. */
export const goblinWalletOf = (servers: readonly ServerView[] | undefined): ServerView | undefined =>
  servers?.find((server) => server.profile?.id === 'wallet' && server.status === 'connected')

/** The dollar stablecoins the Goblin Wallet's status says it holds (`stablecoinUsd`); none when it does not say. */
export const heldOf = (status: WalletStatus | null | undefined): number | undefined => {
  const value = Number(status?.stablecoinUsd ?? Number.NaN)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * What the wallet's balance does for one way to pay: how many payments it covers, or what to add before the first.
 * Counted in whole cents, so $15.00 covers one $15 payment.
 */
export type Coverage = { readonly covers: number } | { readonly short: string }

export const coverageOf = (dollars: number, offer: PlanOffer): Coverage => {
  const have = Math.floor(dollars * 100 + 1e-6)
  const price = centsOf(offer.amountUsd) ?? 0
  if (price <= 0) return { covers: 0 }
  const covers = Math.floor(have / price)
  return covers >= 1 ? { covers } : { short: usd((price - have) / 100) }
}

/** The line under a choice: "Covers 152 days of use", "Covers 10 payments", or "Add $11.80 to your wallet first". */
export const coverageLine = (coverage: Coverage, id: BillingId): string => {
  if ('short' in coverage) return `Add ${coverage.short} to your wallet first.`
  const { covers } = coverage
  if (id === 'day') return `Covers ${String(covers)} ${covers === 1 ? 'day' : 'days'} of use.`
  return `Covers ${String(covers)} ${covers === 1 ? 'payment' : 'payments'}.`
}

/**
 * The wallet's Add funds page on the origin of `walletUrl` (a wallet URL goblin built, or the connection's configured
 * endpoint, never one a server sent), offering a way back to `back`, an absolute URL of this app. None for a URL that
 * does not parse.
 */
export const addFundsUrl = (walletUrl: string, back: string): string | undefined => {
  if (!URL.canParse(walletUrl)) return undefined
  const page = new URL('/add-funds', new URL(walletUrl).origin)
  page.searchParams.set('return', back)
  return page.href
}

/**
 * Where Add funds comes back to after a day pass could not take a day's payment: the return page confirms the same
 * subscription, which takes that day's payment, then goes on to `back` (a path of this app).
 */
export const confirmAgainUrl = (origin: string, subscription: string, back: string | undefined): string => {
  const page = new URL('/subscribe/success', origin)
  page.searchParams.set('subscription', subscription)
  if (back !== undefined) page.searchParams.set('return', back)
  return page.href
}

/** A day pass that could not take a day's payment: goblin is paused until the owner adds funds and it is confirmed. */
export const unpaidDayPass = (state: BillingState | undefined): WalletPlan | undefined =>
  state !== undefined && !state.active && state.wallet?.billing === 'day' && state.wallet.status === 'lapsed'
    ? state.wallet
    : undefined

/** The Add funds page for an unpaid day pass, back through the return page that takes the day's payment. */
export const dayPassFundsUrl = (wallet: WalletPlan, origin: string, back: string | undefined): string | undefined =>
  addFundsUrl(wallet.manageUrl, confirmAgainUrl(origin, wallet.subscription, back))

/**
 * What `/subscribe` offers this account for a way to pay: `subscribe` (sign it), `switch` (a day pass moving to
 * monthly), `fund` (a day pass that could not pay: add funds rather than sign again), `current` (how Pro is paid now)
 * or `none` (Pro comes another way, or this one cannot be taken from the current one).
 */
export type ChoiceAction = 'subscribe' | 'switch' | 'fund' | 'current' | 'none'

export const choiceAction = (state: BillingState, id: BillingId): ChoiceAction => {
  if (!state.active) return id === 'day' && unpaidDayPass(state) !== undefined ? 'fund' : 'subscribe'
  const wallet = state.source === 'wallet' ? state.wallet : undefined
  if (wallet === undefined) return 'none'
  if (wallet.billing === id) return 'current'
  return wallet.billing === 'day' && id === 'month' ? 'switch' : 'none'
}

/** When a monthly subscription is paid through, renews or ended, in words. */
function monthLine(wallet: WalletPlan, now: number): string {
  const through = wallet.paidThrough === null ? undefined : dayAndMonth(wallet.paidThrough)
  switch (wallet.status) {
    case 'pending':
      return 'Signed in your Goblin Wallet; the first payment has not gone through yet.'
    case 'lapsed':
      return 'The payment did not go through, so Pro has ended. Subscribe again any time.'
    case 'cancelled':
      if (through === undefined) return 'Cancelled in your Goblin Wallet.'
      return wallet.paidThrough !== null && wallet.paidThrough > now
        ? `Cancelled in your Goblin Wallet. Pro runs to ${through}.`
        : `Cancelled in your Goblin Wallet. Pro ended on ${through}.`
    case 'grace':
      return `The last payment did not go through. goblin tries again each day until ${dayAndMonth(wallet.graceUntil ?? now)}.`
    case 'active':
      return through === undefined
        ? `Next, ${usd(wallet.amountUsd)} from your Goblin Wallet.`
        : `Paid through ${through}. Next, ${usd(wallet.amountUsd)} from your Goblin Wallet.`
  }
}

/** Where a day pass stands: today paid or still to pay on first use, could not pay, or cancelled. */
function dayLine(wallet: WalletPlan, now: number): string {
  const price = usd(wallet.amountUsd)
  const paidToday = wallet.paidThrough !== null && wallet.paidThrough > now
  switch (wallet.status) {
    case 'pending':
      return 'Signed in your Goblin Wallet; it starts once goblin confirms it.'
    case 'lapsed':
      return `Your day pass could not take ${price} for today, so goblin is paused. Add funds in your wallet, and goblin takes it then.`
    case 'cancelled':
      return paidToday
        ? 'Cancelled in your Goblin Wallet. Pro runs to the end of today.'
        : 'Cancelled in your Goblin Wallet.'
    case 'grace':
    case 'active':
      return paidToday
        ? `Today is paid. Each day you use goblin, its first message takes ${price}; idle days cost nothing.`
        : `Your first message today takes ${price} from your Goblin Wallet. Idle days cost nothing.`
  }
}

/** A wallet subscription's line on Settings' plan card. `now` is epoch milliseconds. */
export const walletLine = (wallet: WalletPlan, now: number): string =>
  wallet.billing === 'day' ? dayLine(wallet, now) : monthLine(wallet, now)

/** Where the plan stands, in words, for any way it comes: the wallet, an override, or the card checkout. */
export function planLine(state: BillingState, now: number): string {
  if (state.wallet !== undefined && (state.source === 'wallet' || !state.active)) return walletLine(state.wallet, now)
  if (!state.active) return 'goblin answers once you pick a day pass or monthly.'
  if (state.until === null) return 'Included with your account.'
  const until = shortDate(state.until)
  if (state.cancelAtPeriodEnd || state.status === 'cancelled') return `Access until ${until}.`
  if (state.status === 'past_due' || state.status === 'on_hold') return `Payment grace until ${until}.`
  return `Renews on ${until}.`
}

/** The plan card's description: how Pro is paid (or can be) and its daily Credits. */
export function planSummary(state: BillingState): string {
  const wallet = state.wallet
  const offer = wallet === undefined ? undefined : offerOf(state.catalog, wallet.billing)
  const credits = offer?.dailyCredits ?? creditsOf(state.catalog)
  const perDay = credits === undefined ? '' : ` · ${String(credits)} model Credits a day`
  if (wallet !== undefined && (state.active || unpaidDayPass(state) !== undefined)) {
    const paid =
      wallet.billing === 'day'
        ? `Day pass: ${usd(wallet.amountUsd)} a day you use goblin`
        : `Monthly: ${usd(wallet.amountUsd)} every ${String(wallet.periodDays)} days`
    return `${paid}, in USDC${perDay}`
  }
  return state.catalog.length === 0 ? `Paid in USDC${perDay}` : `${pricesOf(state.catalog)}, in USDC${perDay}`
}
