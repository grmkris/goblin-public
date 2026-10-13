import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'
import { payToday } from '../src/billing/day-pass.ts'
import { DEFAULT_CATALOG } from '../src/billing/plans.ts'
import {
  type WalletBillingDeps,
  confirmWalletSubscription,
  runWalletRenewals,
  startWalletSubscription,
} from '../src/billing/renewals.ts'
import type { WalletSubscription } from '../src/billing/schema.ts'
import {
  type WalletCollection,
  WalletMerchant,
  type WalletMerchantApi,
  type WalletSubscriptionView,
} from '../src/billing/wallet.ts'
import { unread } from './fake.ts'

const DAY = 86_400_000
const USER = 'u1'
const PASS = `sub_${'a'.repeat(32)}`
const MONTHLY = `sub_${'b'.repeat(32)}`
/** Day 10 at midnight UTC: when the day pass starts, as the wallet aligns it. */
const SIGNED = 10 * DAY

/** auth D1's billing tables in memory: the account has no card subscription, and its wallet subscriptions are kept. */
const memoryStore = () => {
  const rows = new Map<string, WalletSubscription>()
  const store: WalletBillingDeps['store'] = {
    account: () => Effect.succeed(undefined),
    subscriptions: () => Effect.succeed([]),
    walletSubscriptions: (userId) =>
      Effect.sync(() => [...rows.values()].filter((row) => row.userId === userId).toReversed()),
    writeWalletSubscription: (row) =>
      Effect.sync(() => {
        rows.set(row.subscriptionId, row)
        return unread
      }),
    supersedeWalletSubscriptions: (userId, kept, now) =>
      Effect.sync(() => {
        for (const row of rows.values())
          if (row.userId === userId && row.subscriptionId !== kept && row.status !== 'cancelled')
            rows.set(row.subscriptionId, { ...row, status: 'superseded', nextAttemptAt: null, updatedAt: now })
        return unread
      }),
    dueWalletSubscriptions: (now) =>
      Effect.sync(() =>
        [...rows.values()].filter(
          (row) =>
            row.billing === 'month' &&
            ['pending', 'active', 'grace'].includes(row.status) &&
            row.nextAttemptAt !== null &&
            row.nextAttemptAt <= now,
        ),
      ),
    checkoutCount: () => Effect.succeed(0),
    recordCheckout: () => Effect.succeed(unread),
  }
  return { store, rows }
}

const view = (change: Partial<WalletSubscriptionView> = {}): WalletSubscriptionView => ({
  id: PASS,
  reference: `goblin:${USER}`,
  billing: 'day',
  status: 'active',
  chain: 'base',
  amountUsd: '1.00',
  periodDays: 1,
  startsAt: new Date(SIGNED).toISOString(),
  collector: '0x1111111111111111111111111111111111111111',
  shortUsd: '0',
  ...change,
})

/** The wallet as a merchant: its subscriptions by id, and each collection's answer in turn (paid once they run out). */
const fakeWallet = (views: Readonly<Record<string, WalletSubscriptionView>>, answers: WalletCollection[] = []) => {
  const collected: { readonly id: string; readonly period: number; readonly operationId: string }[] = []
  const created: unknown[] = []
  const merchant: WalletMerchantApi = {
    origin: 'https://wallet.test',
    create: (request) =>
      Effect.sync(() => {
        created.push(request)
        return { id: MONTHLY, signUrl: `https://wallet.test/subscribe/${MONTHLY}`, expiresAt: '2026-10-13T00:00:00Z' }
      }),
    get: (id) => Effect.succeed(views[id] ?? view()),
    collect: (id, request) =>
      Effect.sync(() => {
        collected.push({ id, ...request })
        return answers.shift() ?? { status: 'paid', txHash: '0xabc' }
      }),
  }
  return { merchant, collected, created }
}

const deps = (store: WalletBillingDeps['store']): WalletBillingDeps => ({
  store,
  appUrl: 'https://goblin.test',
  catalog: DEFAULT_CATALOG,
  notify: () => Effect.void,
})

describe('the day pass (ADR 0054)', () => {
  it.effect('turns Pro on when confirmed without taking anything, and refuses a wallet already short of a day', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(SIGNED + 3_600_000)
      const { store, rows } = memoryStore()
      const short = fakeWallet({ [PASS]: view({ shortUsd: '0.40' }) })
      expect(
        yield* confirmWalletSubscription(deps(store), USER, PASS).pipe(
          Effect.provideService(WalletMerchant, short.merchant),
        ),
      ).toEqual({ error: 'payment_short' })
      expect(rows.size).toBe(0)
      const wallet = fakeWallet({ [PASS]: view() })
      const confirmed = yield* confirmWalletSubscription(deps(store), USER, PASS).pipe(
        Effect.provideService(WalletMerchant, wallet.merchant),
      )
      expect(confirmed).toEqual({
        receipt: { status: 'paid', amountUsd: '1.00', periodDays: 1, paidFrom: null, paidThrough: null },
      })
      expect(wallet.collected).toEqual([])
      expect(rows.get(PASS)).toMatchObject({ billing: 'day', status: 'active', period: 0, nextAttemptAt: null })
    }),
  )

  it.effect(
    "takes each UTC day's payment once, on the first message of the day, and nothing on a day already paid",
    () =>
      Effect.gen(function* () {
        const { store, rows } = memoryStore()
        const wallet = fakeWallet({ [PASS]: view() })
        const pay = payToday(store, USER).pipe(Effect.provideService(WalletMerchant, wallet.merchant))
        yield* TestClock.setTime(SIGNED + 3_600_000)
        yield* confirmWalletSubscription(deps(store), USER, PASS).pipe(
          Effect.provideService(WalletMerchant, wallet.merchant),
        )
        expect(yield* pay).toBe('settled')
        expect(yield* pay).toBe('settled')
        expect(rows.get(PASS)).toMatchObject({ period: 1, paidThrough: SIGNED + DAY, lastTx: '0xabc' })
        // An idle day costs nothing; the next day used is its own period, counted in UTC days since the start.
        yield* TestClock.setTime(SIGNED + 2 * DAY + 60_000)
        expect(yield* pay).toBe('settled')
        expect(wallet.collected).toEqual([
          { id: PASS, period: 1, operationId: `day:${PASS}:1` },
          { id: PASS, period: 3, operationId: `day:${PASS}:3` },
        ])
        expect(rows.get(PASS)).toMatchObject({ status: 'active', period: 3, paidThrough: SIGNED + 3 * DAY })
      }),
  )

  it.effect('lapses on a day the wallet is short, and comes back on once the owner adds funds and confirms', () =>
    Effect.gen(function* () {
      const { store, rows } = memoryStore()
      const wallet = fakeWallet({ [PASS]: view() }, [
        { status: 'failed', reason: 'insufficient_funds' },
        { status: 'failed', reason: 'insufficient_funds' },
      ])
      yield* TestClock.setTime(SIGNED + 3_600_000)
      const confirm = confirmWalletSubscription(deps(store), USER, PASS).pipe(
        Effect.provideService(WalletMerchant, wallet.merchant),
      )
      yield* confirm
      expect(yield* payToday(store, USER).pipe(Effect.provideService(WalletMerchant, wallet.merchant))).toBe('ended')
      expect(rows.get(PASS)).toMatchObject({ status: 'lapsed', lastFailure: 'insufficient_funds', period: 0 })
      // Still short: confirming says so and leaves it off.
      expect(yield* confirm).toEqual({ error: 'payment_short' })
      // Funds added: confirming takes the day, and Pro is on again.
      expect(yield* confirm).toMatchObject({ receipt: { status: 'paid', paidThrough: SIGNED + DAY } })
      expect(rows.get(PASS)).toMatchObject({ status: 'active', period: 1, lastFailure: null })
      expect(wallet.collected.map((each) => each.period)).toEqual([1, 1, 1])
    }),
  )

  it.effect(
    'is cancelled once revoked, tries again after a chain failure, and ends only when the pass itself has',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(SIGNED + 3_600_000)
        const outcome = (answer: WalletCollection, wallet: WalletSubscriptionView = view()) =>
          Effect.gen(function* () {
            const { store, rows } = memoryStore()
            const { merchant } = fakeWallet({ [PASS]: wallet }, [answer])
            yield* confirmWalletSubscription(deps(store), USER, PASS).pipe(
              Effect.provideService(WalletMerchant, merchant),
            )
            const result = yield* payToday(store, USER).pipe(Effect.provideService(WalletMerchant, merchant))
            return [result, rows.get(PASS)?.status] as const
          })
        expect(yield* outcome({ status: 'failed', reason: 'revoked' })).toEqual(['ended', 'cancelled'])
        expect(yield* outcome({ status: 'failed', reason: 'chain' })).toEqual(['retry', 'active'])
        expect(yield* outcome({ status: 'pending' })).toEqual(['retry', 'active'])
        // `expired` for a day that ended unpaid (a message just before midnight) is not the pass's end.
        expect(yield* outcome({ status: 'failed', reason: 'expired' })).toEqual(['retry', 'active'])
      }),
  )
})

describe('moving from the day pass to monthly (ADR 0054)', () => {
  it.effect(
    'lets a day pass start monthly, supersedes the pass once the first month is paid, and no cron pulls a day',
    () =>
      Effect.gen(function* () {
        const { store, rows } = memoryStore()
        const monthly = view({
          id: MONTHLY,
          billing: 'month',
          amountUsd: '15.00',
          periodDays: 30,
          startsAt: new Date(SIGNED + 5 * DAY).toISOString(),
        })
        const wallet = fakeWallet({ [PASS]: view(), [MONTHLY]: monthly })
        const run = <A, E>(self: Effect.Effect<A, E, WalletMerchant>) =>
          self.pipe(Effect.provideService(WalletMerchant, wallet.merchant))
        yield* TestClock.setTime(SIGNED + 3_600_000)
        yield* run(confirmWalletSubscription(deps(store), USER, PASS))
        const back = { back: '/c/main', stage: 'test' }
        expect(yield* run(startWalletSubscription(deps(store), USER, { ...back, billing: 'day' }))).toEqual({
          error: 'already_subscribed',
        })
        expect(yield* run(startWalletSubscription(deps(store), USER, { ...back, billing: 'month' }))).toEqual({
          signUrl: `https://wallet.test/subscribe/${MONTHLY}`,
        })
        expect(wallet.created).toEqual([
          {
            offer: DEFAULT_CATALOG.month,
            reference: `goblin:${USER}`,
            returnUrl: 'https://goblin.test/subscribe/success?return=%2Fc%2Fmain',
          },
        ])
        yield* TestClock.setTime(SIGNED + 5 * DAY + 3_600_000)
        expect(yield* run(confirmWalletSubscription(deps(store), USER, MONTHLY))).toMatchObject({
          receipt: { status: 'paid', amountUsd: '15.00', paidThrough: SIGNED + 35 * DAY },
        })
        expect(rows.get(PASS)?.status).toBe('superseded')
        expect(rows.get(MONTHLY)).toMatchObject({ status: 'active', period: 1, nextAttemptAt: SIGNED + 35 * DAY })
        // Monthly is Pro now: starting anything else is refused, and the superseded pass is never collected again.
        expect(yield* run(startWalletSubscription(deps(store), USER, { ...back, billing: 'month' }))).toEqual({
          error: 'already_subscribed',
        })
        expect(yield* run(payToday(store, USER))).toBe('settled')
        yield* TestClock.setTime(SIGNED + 35 * DAY + 1)
        yield* run(runWalletRenewals(deps(store)))
        expect(wallet.collected).toEqual([
          { id: MONTHLY, period: 1, operationId: `month:${MONTHLY}:1` },
          { id: MONTHLY, period: 2, operationId: `month:${MONTHLY}:2` },
        ])
      }),
  )
})
