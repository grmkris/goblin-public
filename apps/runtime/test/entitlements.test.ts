import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'
import { type EntitlementPolicy, cachedPolicy } from '../src/billing/gates.ts'
import type { AccountPlan } from '../src/billing/reconcile.ts'
import { Internal } from '../src/http/errors.ts'

const PLAN: AccountPlan = {
  active: true,
  source: 'override',
  until: null,
  dailyCredits: 800,
  status: 'active',
  hasCustomer: false,
  cancelAtPeriodEnd: false,
}

/** A policy whose plan reads auth D1: each read is counted, and answers the next of `answers` (the last one repeats). */
const counted = (answers: readonly (AccountPlan | 'fail')[]) => {
  let reads = 0
  const state = Effect.suspend(() => {
    const answer = answers[Math.min(reads, answers.length - 1)]
    reads += 1
    return answer === 'fail' || answer === undefined
      ? Effect.fail(new Internal({ reason: 'billing storage unavailable' }))
      : Effect.succeed(answer)
  })
  const policy: EntitlementPolicy = { state: () => state, require: () => state }
  return { policy, reads: () => reads }
}

describe('the plan as the agent checks it', () => {
  it.effect('keeps an active plan for 60 seconds, then reads it again', () =>
    Effect.gen(function* () {
      const { policy, reads } = counted([PLAN])
      const plans = yield* cachedPolicy(policy)
      expect(yield* plans.require()).toEqual(PLAN)
      yield* TestClock.adjust('59 seconds')
      expect(yield* plans.state()).toEqual(PLAN)
      expect(yield* plans.require('routines')).toEqual(PLAN)
      expect(reads()).toBe(1)
      yield* TestClock.adjust('2 seconds')
      yield* plans.require()
      expect(reads()).toBe(2)
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
