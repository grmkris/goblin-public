import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'
import { type EntitlementPolicy, Entitlements, cachedPolicy, requirePlan } from '../src/billing/gates.ts'
import { DEFAULT_CATALOG, catalogOffers, planCatalog } from '../src/billing/plans.ts'
import { type AccountPlan, planOf } from '../src/billing/reconcile.ts'
import type { WalletSubscription } from '../src/billing/schema.ts'
import { Internal, SubscriptionRequired } from '../src/http/errors.ts'

const PLAN: AccountPlan = {
  active: true,
  plan: 'pro',
  source: 'override',
  billing: null,
  until: null,
  dailyCredits: 800,
  status: 'active',
  hasCustomer: false,
  cancelAtPeriodEnd: false,
}

/**
 * A policy whose plan reads auth D1: each read is counted, and answers the next of `answers` (the last one repeats).
 * `require` refuses a plan that is not active, as the account's policy does.
 */
const counted = (answers: readonly (AccountPlan | 'fail')[]) => {
  let reads = 0
  const state = Effect.suspend(() => {
    const answer = answers[Math.min(reads, answers.length - 1)]
    reads += 1
    return answer === 'fail' || answer === undefined
      ? Effect.fail(new Internal({ reason: 'billing storage unavailable' }))
      : Effect.succeed(answer)
  })
  const require = Effect.flatMap(state, (plan) =>
    plan.active
      ? Effect.succeed(plan)
      : Effect.fail(new SubscriptionRequired({ subscribe: '/subscribe', feature: 'chat' })),
  )
  const policy: EntitlementPolicy = {
    state: () => state,
    require: () => require,
    payDay: () => Effect.succeed('settled'),
  }
  return { policy, reads: () => reads }
}

describe('the plan as the agent checks it', () => {
  it.effect('keeps an active plan for 60 seconds, then reads it again', () =>
    Effect.gen(function* () {
      const { policy, reads } = counted([PLAN])
      const plans = yield* cachedPolicy(policy)
      expect(yield* plans.require()).toEqual(PLAN)
      yield* TestClock.adjust('59 seconds')
      expect(yield* plans.require('routines')).toEqual(PLAN)
      expect(reads()).toBe(1)
      expect(yield* plans.state()).toEqual(PLAN)
      expect(yield* plans.state()).toEqual(PLAN)
      expect(reads()).toBe(2)
      yield* TestClock.adjust('2 seconds')
      yield* plans.require()
      expect(reads()).toBe(3)
    }),
  )

  it.effect('never keeps an inactive plan, so a new subscription counts at once', () =>
    Effect.gen(function* () {
      const { policy, reads } = counted([{ ...PLAN, active: false }, PLAN])
      const plans = yield* cachedPolicy(policy)
      expect(yield* Effect.flip(plans.require())).toMatchObject({
        _tag: 'SubscriptionRequired',
        subscribe: '/subscribe',
      })
      expect(yield* plans.require()).toEqual(PLAN)
      expect(reads()).toBe(2)
    }),
  )

  it.effect('never keeps a failed read: the next check reads again', () =>
    Effect.gen(function* () {
      const { policy, reads } = counted(['fail', PLAN])
      const plans = yield* cachedPolicy(policy)
      expect(yield* Effect.flip(plans.require())).toMatchObject({ _tag: 'Internal' })
      expect(yield* plans.require()).toEqual(PLAN)
      yield* plans.require()
      expect(reads()).toBe(2)
    }),
  )
})

describe('requirePlan', () => {
  it.effect("asks the agent's plan for the named feature, and refuses one that is not active", () =>
    Effect.gen(function* () {
      const asked: (string | undefined)[] = []
      const policy = (plan: AccountPlan): EntitlementPolicy => ({
        state: () => Effect.succeed(plan),
        require: (feature) => {
          asked.push(feature)
          return plan.active ? Effect.succeed(plan) : Effect.fail(new SubscriptionRequired({ subscribe: '/subscribe' }))
        },
        payDay: () => Effect.succeed('settled'),
      })
      expect(yield* requirePlan('routines').pipe(Effect.provideService(Entitlements, policy(PLAN)))).toBe(PLAN)
      const lapsed = yield* requirePlan().pipe(
        Effect.provideService(Entitlements, policy({ ...PLAN, active: false })),
        Effect.flip,
      )
      expect(lapsed).toBeInstanceOf(SubscriptionRequired)
      expect(asked).toEqual(['routines', undefined])
    }),
  )

  it.effect('refuses an account without a plan as `chat`, also from the kept answer, and Pro keeps every feature', () =>
    Effect.gen(function* () {
      const none: AccountPlan = { ...PLAN, active: false, plan: null, source: 'none', dailyCredits: 0 }
      const plans = yield* cachedPolicy(counted([none]).policy)
      for (const feature of [undefined, 'routines', 'handOver', 'subagents'] as const)
        expect(yield* Effect.flip(plans.require(feature))).toMatchObject({
          _tag: 'SubscriptionRequired',
          subscribe: '/subscribe',
          feature: 'chat',
        })
      const pro = yield* cachedPolicy(counted([PLAN]).policy)
      for (const feature of [undefined, 'routines', 'handOver', 'subagents'] as const)
        expect(yield* pro.require(feature)).toEqual(PLAN)
    }),
  )

  it.effect('drops the kept plan once a day pass has tried its day, so a day it could not pay ends Pro at once', () =>
    Effect.gen(function* () {
      const day: AccountPlan = { ...PLAN, source: 'wallet', billing: 'day' }
      const lapsed: AccountPlan = { ...day, active: false, plan: null, source: 'none', billing: null }
      const { policy, reads } = counted([day, lapsed])
      const plans = yield* cachedPolicy({ ...policy, payDay: () => Effect.succeed('ended') })
      expect(yield* plans.require()).toEqual(day)
      expect(yield* plans.require()).toEqual(day)
      expect(reads()).toBe(1)
      expect(yield* plans.payDay()).toBe('ended')
      expect(yield* Effect.flip(plans.require())).toMatchObject({ _tag: 'SubscriptionRequired', feature: 'chat' })
      expect(reads()).toBe(2)
    }),
  )
})

/** An account with no billing row and no subscription, as auth D1 answers for a new sign-up. */
const newAccount = {
  account: () => Effect.succeed(undefined),
  subscriptions: () => Effect.succeed([]),
}

const DAY = 86_400_000
/** A wallet subscription row as billing keeps it; a day pass by default, signed on day 10 and never used. */
const row = (change: Partial<WalletSubscription> = {}): WalletSubscription => ({
  subscriptionId: `sub_${'a'.repeat(32)}`,
  userId: 'u1',
  billing: 'day',
  status: 'active',
  amountUsd: '1.00',
  periodDays: 1,
  startsAt: 10 * DAY,
  period: 0,
  paidThrough: null,
  nextAttemptAt: null,
  graceUntil: null,
  remindedPeriod: 0,
  lastOperation: null,
  lastTx: null,
  lastFailure: null,
  createdAt: 10 * DAY,
  updatedAt: 10 * DAY,
  ...change,
})
const withWallet = (rows: readonly WalletSubscription[]) => ({
  ...newAccount,
  walletSubscriptions: () => Effect.succeed([...rows]),
})

describe('the plan an account has (ADR 0054)', () => {
  it.effect('is none for a new account: there is no free plan', () =>
    Effect.gen(function* () {
      expect(yield* planOf(newAccount, 'u1', 'prod', 'live_mode', { at: 0 })).toEqual({
        active: false,
        plan: null,
        source: 'none',
        billing: null,
        until: null,
        dailyCredits: 0,
        status: 'unsubscribed',
        hasCustomer: false,
        cancelAtPeriodEnd: false,
      })
    }),
  )

  it.effect("is Pro on a day pass while it is on, with the catalog's Credits, and none once a day could not pay", () =>
    Effect.gen(function* () {
      const catalog = { ...DEFAULT_CATALOG, day: { ...DEFAULT_CATALOG.day, dailyCredits: 300 } }
      const at = 40 * DAY
      expect(yield* planOf(withWallet([row()]), 'u1', 'prod', 'live_mode', { at, catalog })).toMatchObject({
        active: true,
        plan: 'pro',
        source: 'wallet',
        billing: 'day',
        until: null,
        dailyCredits: 300,
      })
      const lapsed = row({ status: 'lapsed', lastFailure: 'insufficient_funds' })
      expect(yield* planOf(withWallet([lapsed]), 'u1', 'prod', 'live_mode', { at })).toMatchObject({
        active: false,
        plan: null,
      })
      // Revoked after a day was paid: Pro to the end of that UTC day, then none.
      const cancelled = row({ status: 'cancelled', period: 30, paidThrough: 41 * DAY })
      expect(yield* planOf(withWallet([cancelled]), 'u1', 'prod', 'live_mode', { at })).toMatchObject({
        active: true,
        until: 41 * DAY,
        cancelAtPeriodEnd: true,
      })
      expect(yield* planOf(withWallet([cancelled]), 'u1', 'prod', 'live_mode', { at: 41 * DAY })).toMatchObject({
        active: false,
      })
    }),
  )

  it.effect('comes from monthly once it is paid, and never from a superseded day pass or one not paid yet', () =>
    Effect.gen(function* () {
      const at = 40 * DAY
      const monthly = row({
        subscriptionId: `sub_${'b'.repeat(32)}`,
        billing: 'month',
        amountUsd: '15.00',
        periodDays: 30,
        startsAt: 39 * DAY,
        period: 1,
        paidThrough: 69 * DAY,
        nextAttemptAt: 69 * DAY,
        createdAt: 39 * DAY,
      })
      const switching = [{ ...monthly, status: 'pending' as const, period: 0, paidThrough: null }, row()]
      expect(yield* planOf(withWallet(switching), 'u1', 'test', 'test_mode', { at })).toMatchObject({
        active: true,
        billing: 'day',
      })
      const switched = [monthly, row({ status: 'superseded' })]
      expect(yield* planOf(withWallet(switched), 'u1', 'test', 'test_mode', { at })).toMatchObject({
        active: true,
        billing: 'month',
        until: 69 * DAY,
      })
      expect(
        yield* planOf(withWallet([row({ status: 'superseded' })]), 'u1', 'test', 'test_mode', { at }),
      ).toMatchObject({ active: false })
    }),
  )
})

describe('the catalog (GOBLIN_PLAN_CATALOG)', () => {
  it('is the day pass at $1 a day and monthly at $15 every 30 days, with 800 Credits a day, when unset', () => {
    for (const unset of [undefined, '', '  ']) expect(planCatalog(unset)).toEqual(DEFAULT_CATALOG)
    expect(catalogOffers(DEFAULT_CATALOG)).toEqual([
      { id: 'day', amountUsd: '1.00', periodDays: 1, dailyCredits: 800 },
      { id: 'month', amountUsd: '15.00', periodDays: 30, dailyCredits: 800 },
    ])
  })

  it('changes only the fields it names', () => {
    expect(planCatalog('{"day":{"amountUsd":"2.00"},"month":{"amountUsd":"20.00","periodDays":28}}')).toEqual({
      day: { id: 'day', amountUsd: '2.00', periodDays: 1, dailyCredits: 800 },
      month: { id: 'month', amountUsd: '20.00', periodDays: 28, dailyCredits: 800 },
    })
  })

  it('keeps the defaults for a setting that does not decode or goes past its caps', () => {
    for (const bad of [
      'not json',
      '[]',
      '{"day":{"amountUsd":"1"}}',
      '{"day":{"amountUsd":"0.00"}}',
      '{"day":{"amountUsd":"1000.00"}}',
      '{"day":{"periodDays":2}}',
      '{"month":{"periodDays":31}}',
      '{"month":{"dailyCredits":10001}}',
      '{"month":{"dailyCredits":2.5}}',
    ])
      expect(planCatalog(bad), bad).toEqual(DEFAULT_CATALOG)
  })
})
