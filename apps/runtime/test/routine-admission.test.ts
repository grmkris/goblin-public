import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Entitlements } from '../src/billing/gates.ts'
import type { AccountPlan } from '../src/billing/reconcile.ts'
import { Budget } from '../src/budget.ts'
import { type AppError, BudgetExhausted, Internal, ResidentInactive, SubscriptionRequired } from '../src/http/errors.ts'
import { Resident } from '../src/mcp/service.ts'
import { admissionSkip } from '../src/routines/runner.ts'

const PLAN: AccountPlan = {
  active: true,
  source: 'override',
  until: null,
  dailyCredits: 800,
  status: 'active',
  hasCustomer: false,
  cancelAtPeriodEnd: false,
}

/** A stand-in implementing only the members admission reaches. */
const fake = <T>(members: Partial<T>): T =>
  // SAFETY: each fake below is given every member admissionSkip calls on it.
  members as T

/** Admission's verdict when the plan, resident authority and today's budget answer as given. */
const skipOf = (
  answers: {
    readonly plan?: Effect.Effect<AccountPlan, Internal | SubscriptionRequired>
    readonly resident?: Effect.Effect<void, AppError>
    readonly budget?: Effect.Effect<void, AppError>
  } = {},
) =>
  admissionSkip.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(Entitlements, {
          state: () => Effect.succeed(PLAN),
          require: () => answers.plan ?? Effect.succeed(PLAN),
        }),
        Layer.succeed(Resident, fake<typeof Resident.Service>({ require: () => answers.resident ?? Effect.void })),
        Layer.succeed(Budget, fake<typeof Budget.Service>({ require: () => answers.budget ?? Effect.void })),
      ),
    ),
  )

describe('routine admission (R3)', () => {
  it.effect('runs a firing the plan, resident authority and budget allow', () =>
    Effect.gen(function* () {
      expect(yield* skipOf()).toBeUndefined()
    }),
  )

  it.effect('records a firing as skipped, by its reason, only when one of those refuses it', () =>
    Effect.gen(function* () {
      expect(yield* skipOf({ plan: Effect.fail(new SubscriptionRequired({ subscribe: '/subscribe' })) })).toBe(
        'SubscriptionRequired',
      )
      expect(yield* skipOf({ resident: Effect.fail(new ResidentInactive({ state: 'revoked' })) })).toBe(
        'ResidentInactive',
      )
      expect(yield* skipOf({ budget: Effect.fail(new BudgetExhausted({ limit: 800, resetsAt: 86_400 })) })).toBe(
        'BudgetExhausted',
      )
    }),
  )

  it.effect('fails the admission when auth D1 or storage fails, instead of skipping the firing', () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(
        skipOf({ plan: Effect.fail(new Internal({ reason: 'billing storage unavailable' })) }),
      )
      expect(failed).toMatchObject({ _tag: 'Internal' })
    }),
  )
})
