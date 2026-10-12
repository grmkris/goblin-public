import { describe, expect, it, vi } from 'vitest'
import type { BillingState, ServerView, WalletPlan } from '@goblin/contracts'
import { SubscriptionRequired } from '@goblin/contracts/api'
import { planStatus } from '../src/lib/labels.ts'
import {
  addFundsUrl,
  choiceAction,
  choiceOf,
  coverageLine,
  coverageOf,
  dayPassFundsUrl,
  goblinWalletOf,
  held,
  heldOf,
  planLine,
  planSummary,
  pricesOf,
  proPrices,
  unpaidDayPass,
  usd,
  walletLine,
} from '../src/lib/pro.ts'
import { parseSubscribedSearch } from '../src/lib/subscribe-search.ts'
import { makeUpgradePrompts } from '../src/lib/upgrade-prompt.ts'

const DAY = { id: 'day', amountUsd: '1.00', periodDays: 1, dailyCredits: 800 } as const
const MONTH = { id: 'month', amountUsd: '15.00', periodDays: 30, dailyCredits: 800 } as const
const SUB = `sub_${'ab'.repeat(16)}`
const NOW = Date.UTC(2026, 9, 13, 12)
const END_OF_TODAY = Date.UTC(2026, 9, 14) - 1

const NONE: BillingState = {
  active: false,
  source: 'none',
  until: null,
  dailyCredits: 0,
  status: 'none',
  hasCustomer: false,
  cancelAtPeriodEnd: false,
  mode: null,
  plan: null,
  catalog: [DAY, MONTH],
  walletPay: true,
}

const walletOf = (change: Partial<WalletPlan> = {}): WalletPlan => ({
  subscription: SUB,
  billing: 'day',
  status: 'active',
  amountUsd: '1.00',
  periodDays: 1,
  paidThrough: null,
  nextPaymentAt: null,
  graceUntil: null,
  manageUrl: 'https://wallet.test/limits',
  ...change,
})

/** On Pro, paid from the Goblin Wallet as `wallet` says. */
const onWallet = (change: Partial<WalletPlan> = {}): BillingState => ({
  ...NONE,
  active: true,
  source: 'wallet',
  plan: 'pro',
  dailyCredits: 800,
  wallet: walletOf(change),
})

// SAFETY: test servers carry only the fields `goblinWalletOf` reads.
const servers = (list: readonly object[]) => list as readonly ServerView[]

/** A day pass that could not take today's payment: no plan until the owner adds funds. */
const UNPAID: BillingState = { ...NONE, wallet: walletOf({ status: 'lapsed' }) }

describe("goblin Pro's prices, from the deployment's catalog", () => {
  it('writes a price without empty cents, and a balance always with cents, never rounded up', () => {
    expect(usd('1.00')).toBe('$1')
    expect(usd('15')).toBe('$15')
    expect(usd('9.5')).toBe('$9.50')
    expect(held(152.6)).toBe('$152.60')
    expect(held(0.999)).toBe('$0.99')
    expect(held(3)).toBe('$3.00')
  })

  it('names each way to pay in the words of the page, day pass first', () => {
    expect(choiceOf(DAY)).toEqual({
      name: 'Day pass',
      price: '$1',
      per: 'a day you use goblin',
      suits: 'Nothing on idle days.',
    })
    expect(choiceOf(MONTH)).toMatchObject({ name: 'Monthly', price: '$15', per: 'every 30 days' })
    expect(pricesOf([DAY, MONTH])).toBe('$1 a day you use goblin, or $15 every 30 days')
    expect(proPrices([DAY, { ...MONTH, amountUsd: '20.00' }])).toBe(
      'Pro is $1 a day you use goblin, or $20 every 30 days, paid in USDC from your Goblin Wallet.',
    )
  })
})

describe("the Goblin Wallet's balance against each way to pay", () => {
  it("reads the wallet's stablecoin dollars from its status, and nothing it does not say", () => {
    const status = { kind: 'wallet', paid: 'ready', funding: 'ready', tokens: [] } as const
    expect(heldOf({ ...status, stablecoinUsd: '152.6' })).toBe(152.6)
    expect(heldOf(status)).toBeUndefined()
    expect(heldOf({ ...status, stablecoinUsd: 'lots' })).toBeUndefined()
    expect(heldOf(null)).toBeUndefined()
  })

  it('finds the connected Goblin Wallet among the servers, never one still to sign in', () => {
    const wallet = { connectionId: 'c1', status: 'connected', profile: { id: 'wallet' } }
    const other = { connectionId: 'c2', status: 'connected', profile: { id: 'mercator' } }
    expect(goblinWalletOf(servers([other, wallet]))?.connectionId).toBe('c1')
    expect(goblinWalletOf(servers([{ ...wallet, status: 'needs_auth' }]))).toBeUndefined()
    expect(goblinWalletOf(undefined)).toBeUndefined()
  })

  it('counts the payments a balance covers in whole cents, or what to add before the first', () => {
    expect(coverageOf(152.6, DAY)).toEqual({ covers: 152 })
    expect(coverageOf(152.6, MONTH)).toEqual({ covers: 10 })
    expect(coverageOf(15, MONTH)).toEqual({ covers: 1 })
    expect(coverageOf(3.2, MONTH)).toEqual({ short: '$11.80' })
    expect(coverageOf(0, DAY)).toEqual({ short: '$1' })
    expect(coverageLine({ covers: 152 }, 'day')).toBe('Covers 152 days of use.')
    expect(coverageLine({ covers: 1 }, 'month')).toBe('Covers 1 payment.')
    expect(coverageLine({ short: '$11.80' }, 'month')).toBe('Add $11.80 to your wallet first.')
  })
})

describe('the way back from adding funds', () => {
  it("opens the wallet's Add funds page on goblin's own wallet origin, with a way back", () => {
    const url = new URL(addFundsUrl('https://wallet.test/limits', 'https://app.test/subscribe') ?? '')
    expect(url.origin + url.pathname).toBe('https://wallet.test/add-funds')
    expect(url.searchParams.get('return')).toBe('https://app.test/subscribe')
    expect(addFundsUrl('not a url', 'https://app.test/')).toBeUndefined()
  })

  it('brings an unpaid day pass back through the return page, which confirms it and goes on', () => {
    const wallet = unpaidDayPass(UNPAID)
    expect(wallet?.subscription).toBe(SUB)
    const back = new URL(
      new URL(dayPassFundsUrl(wallet ?? walletOf(), 'https://app.test', '/c/7?thread=2') ?? '').searchParams.get(
        'return',
      ) ?? '',
    )
    expect(back.origin + back.pathname).toBe('https://app.test/subscribe/success')
    expect(parseSubscribedSearch(Object.fromEntries(back.searchParams))).toEqual({
      subscription: SUB,
      return: '/c/7?thread=2',
    })
  })

  it('counts as unpaid only a lapsed day pass without a plan', () => {
    expect(unpaidDayPass(NONE)).toBeUndefined()
    expect(unpaidDayPass({ ...NONE, wallet: walletOf({ billing: 'month', status: 'lapsed' }) })).toBeUndefined()
    expect(unpaidDayPass(onWallet())).toBeUndefined()
  })
})

describe('what /subscribe offers each account', () => {
  it('offers both ways to an account without a plan, and funds rather than a new day pass after one could not pay', () => {
    expect([choiceAction(NONE, 'day'), choiceAction(NONE, 'month')]).toEqual(['subscribe', 'subscribe'])
    expect([choiceAction(UNPAID, 'day'), choiceAction(UNPAID, 'month')]).toEqual(['fund', 'subscribe'])
  })

  it('lets a day pass move to monthly, and nothing else on Pro', () => {
    expect([choiceAction(onWallet(), 'day'), choiceAction(onWallet(), 'month')]).toEqual(['current', 'switch'])
    const monthly = onWallet({ billing: 'month', amountUsd: '15.00', periodDays: 30 })
    expect([choiceAction(monthly, 'day'), choiceAction(monthly, 'month')]).toEqual(['none', 'current'])
    const override = { ...NONE, active: true, source: 'override', plan: 'pro' } as const
    expect([choiceAction(override, 'day'), choiceAction(override, 'month')]).toEqual(['none', 'none'])
  })
})

describe("Settings' plan card", () => {
  it('says whether today is paid on a day pass, or that the first message pays it', () => {
    expect(walletLine(walletOf({ paidThrough: END_OF_TODAY }), NOW)).toMatch(/^Today is paid\./u)
    expect(walletLine(walletOf(), NOW)).toBe(
      'Your first message today takes $1 from your Goblin Wallet. Idle days cost nothing.',
    )
    expect(walletLine(walletOf({ paidThrough: NOW - 86_400_000 }), NOW)).toMatch(/^Your first message today/u)
    expect(walletLine(walletOf({ status: 'lapsed' }), NOW)).toMatch(/could not take \$1 for today/u)
  })

  it('says when monthly is paid through, and whether a cancelled one still runs', () => {
    const monthly = walletOf({ billing: 'month', amountUsd: '15.00', periodDays: 30, paidThrough: NOW + 86_400_000 })
    expect(walletLine(monthly, NOW)).toMatch(/^Paid through .+\. Next, \$15 from your Goblin Wallet\.$/u)
    expect(walletLine({ ...monthly, status: 'cancelled' }, NOW)).toMatch(/Pro runs to/u)
    expect(walletLine({ ...monthly, status: 'cancelled', paidThrough: NOW - 1 }, NOW)).toMatch(/Pro ended on/u)
  })

  it('names how Pro is paid, and both ways without a plan', () => {
    expect(planSummary(onWallet())).toBe('Day pass: $1 a day you use goblin, in USDC · 800 model Credits a day')
    expect(planSummary(UNPAID)).toMatch(/^Day pass/u)
    expect(planSummary(NONE)).toBe('$1 a day you use goblin, or $15 every 30 days, in USDC · 800 model Credits a day')
    expect(planLine(NONE, NOW)).toBe('goblin answers once you pick a day pass or monthly.')
    expect(planLine({ ...NONE, active: true, source: 'override', plan: 'pro' }, NOW)).toBe(
      'Included with your account.',
    )
  })

  it('labels a wallet subscription by its own status, and an unpaid day pass as due', () => {
    expect(planStatus(onWallet())).toEqual({ text: 'Active', tone: 'good' })
    expect(planStatus(onWallet({ status: 'cancelled' })).text).toBe('Ending')
    expect(planStatus(onWallet({ billing: 'month', status: 'grace' }))).toEqual({
      text: 'Payment due',
      tone: 'attention',
    })
    expect(planStatus(UNPAID)).toEqual({ text: 'Payment due', tone: 'attention' })
    expect(planStatus(NONE).text).toBe('Not subscribed')
  })
})

describe('the upgrade prompt', () => {
  it('asks about a feature Pro has, and reads the plan again for a refusal for want of any plan', () => {
    const planGone = vi.fn()
    const prompts = makeUpgradePrompts({ planGone })
    prompts.offer(new SubscriptionRequired({ subscribe: '/subscribe', feature: 'chat' }))
    prompts.offer(new SubscriptionRequired({ subscribe: '/subscribe' }))
    expect(planGone).toHaveBeenCalledTimes(2)
    expect(prompts.current()).toBeUndefined()
    prompts.offer(new SubscriptionRequired({ subscribe: '/subscribe', feature: 'hand_over' }))
    expect(prompts.current()).toEqual({ feature: 'hand_over', subscribe: '/subscribe' })
    prompts.dismiss()
    prompts.offer(new SubscriptionRequired({ subscribe: '/subscribe', feature: 'hand_over' }))
    expect(prompts.current()).toBeUndefined()
  })
})
