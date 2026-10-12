import { describe, expect, it } from '@effect/vitest'
import type { UsageToday } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import { Budget } from '../src/budget.ts'
import { type AppError, BudgetExhausted, Internal, SubscriptionRequired } from '../src/http/errors.ts'
import { BUDGET_BLOCKS, budgetVerdict } from '../src/pi/budget.ts'

/**
 * The hook's verdict when today's budget answers `today`, with `admit` refusing a spent day as the budget does, or
 * letting the turn go on when the owner's wallet pays (`paid`, ADR 0047).
 */
const verdictOf = (today: Effect.Effect<UsageToday, AppError>, paid = false) => {
  const spent = Effect.flatMap(today, (current) =>
    current.used >= current.limit
      ? Effect.fail(new BudgetExhausted({ limit: current.limit, resetsAt: current.resetsAt }))
      : Effect.void,
  )
  return budgetVerdict.pipe(
    Effect.provideService(
      Budget,
      Budget.of({
        today: () => today,
        record: () => Effect.void,
        require: () => spent,
        admit: () => (paid ? Effect.void : spent),
      }),
    ),
  )
}

const day = (used: number, limit: number): UsageToday => ({ used, limit, resetsAt: 86_400 })

describe('the budget hook before a tool (R1)', () => {
  it.effect('lets a tool run while the day has budget left, and blocks it as spent once it has none', () =>
    Effect.gen(function* () {
      expect(yield* verdictOf(Effect.succeed(day(1, 2)))).toBe('open')
      expect(yield* verdictOf(Effect.succeed(day(2, 2)))).toBe('exhausted')
      expect(yield* verdictOf(Effect.fail(new BudgetExhausted({ limit: 2, resetsAt: 86_400 })))).toBe('exhausted')
      // A turn the owner's wallet pays for is not held to the day's Credits.
      expect(yield* verdictOf(Effect.succeed(day(2, 2)), true)).toBe('open')
    }),
  )

  it.effect('blocks an account without a plan as unsubscribed, not as spent', () =>
    Effect.gen(function* () {
      expect(yield* verdictOf(Effect.fail(new SubscriptionRequired({ subscribe: '/subscribe' })))).toBe('unsubscribed')
    }),
  )

  it.effect('fails closed as a failed check when the plan or the ledger cannot be read', () =>
    Effect.gen(function* () {
      expect(yield* verdictOf(Effect.fail(new Internal({ reason: 'billing storage unavailable' })))).toBe('failed')
      expect(yield* verdictOf(Effect.die(new Error('D1_ERROR')))).toBe('failed')
      expect(BUDGET_BLOCKS.failed).not.toContain('used up')
      expect(BUDGET_BLOCKS.exhausted).toContain('used up')
    }),
  )
})
