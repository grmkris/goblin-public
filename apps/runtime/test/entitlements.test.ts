import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'
import { type EntitlementPolicy, Entitlements, cachedPolicy, requirePlan } from '../src/billing/gates.ts'
import { freeCredits } from '../src/billing/plans.ts'
import { type AccountPlan, planOf } from '../src/billing/reconcile.ts'
import { Internal, SubscriptionRequired } from '../src/http/errors.ts'

const PLAN: AccountPlan = {
  active: true,
  source: 'override',
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
    plan.active ? Effect.succeed(plan) : Effect.fail(new SubscriptionRequired({ subscribe: '/subscribe' })),
  )
  const policy: EntitlementPolicy = { state: () => state, require: () => require }
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

  it.effect(
    'lets a free plan use the agent and routines that tell, but never a hand-over, also from the kept answer',
    () =>
      Effect.gen(function* () {
        const free: AccountPlan = { ...PLAN, source: 'free', dailyCredits: 50, status: 'free' }
        const plans = yield* cachedPolicy(counted([free]).policy)
        expect(yield* plans.require()).toEqual(free)
        expect(yield* plans.require('agent')).toEqual(free)
        expect(yield* plans.require('routines')).toEqual(free)
        // The refusal names the hand-over, so the owner reads that it is part of Pro.
        expect(yield* Effect.flip(plans.require('handOver'))).toMatchObject({
          _tag: 'SubscriptionRequired',
          feature: 'hand_over',
        })
        // Pro keeps both.
        const pro = yield* cachedPolicy(counted([PLAN]).policy)
        expect(yield* pro.require('routines')).toEqual(PLAN)
        expect(yield* pro.require('handOver')).toEqual(PLAN)
      }),
  )
})

/** An account with no billing row and no subscription, as auth D1 answers for a new sign-up. */
const newAccount = {
  account: () => Effect.succeed(undefined),
  subscriptions: () => Effect.succeed([]),
}

describe('the free plan (FREE_DAILY_CREDITS)', () => {
  it('reads the setting as whole Credits up to Pro, and anything else as no free plan', () => {
    expect([freeCredits('50'), freeCredits('800'), freeCredits('5000')]).toEqual([50, 800, 800])
    for (const none of [undefined, '', '0', '-5', '2.5', 'fifty']) expect(freeCredits(none), String(none)).toBe(0)
  })

  it.effect('gives an account without Pro the free plan only when the deployment sets one', () =>
    Effect.gen(function* () {
      const store = newAccount
      expect(yield* planOf(store, 'u1', 'prod', 'live_mode', { at: 0 })).toMatchObject({
        active: false,
        source: 'none',
        dailyCredits: 0,
      })
      expect(yield* planOf(store, 'u1', 'prod', 'live_mode', { at: 0, free: 50 })).toMatchObject({
        active: true,
        source: 'free',
        dailyCredits: 50,
        status: 'free',
      })
    }),
  )
})
