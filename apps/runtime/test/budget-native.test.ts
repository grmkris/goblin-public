import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { afterEach } from 'vitest'
import type { EntitlementPolicy } from '../src/billing/gates.ts'
import type { AccountPlan } from '../src/billing/reconcile.ts'
import { Budget } from '../src/budget.ts'
import { ModelBudgetLive } from '../src/layers/routines.ts'
import { Db } from '../src/runtime/db.ts'
import { AgentInput, type AgentInputs } from '../src/runtime/input.ts'
import { chatDatabase } from './chats-sqlite.ts'

const PLAN: AccountPlan = {
  active: true,
  source: 'override',
  until: null,
  dailyCredits: 2,
  status: 'active',
  hasCustomer: false,
  cancelAtPeriodEnd: false,
}

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

/** The lane's layer over SQLite, with an account plan whose reads (auth D1) are counted. */
const lane = () => {
  const { db, close } = chatDatabase()
  closes.push(close)
  let reads = 0
  const state = Effect.sync(() => {
    reads += 1
    return PLAN
  })
  const plans: EntitlementPolicy = { state: () => state, require: () => state }
  const layer = ModelBudgetLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        // SAFETY: node:sqlite's Drizzle driver runs the same synchronous query builder as the Durable Object's.
        Layer.succeed(Db, db as never),
        // SAFETY: the budget, the kept plan and the picker read only these from the instance input.
        Layer.succeed(AgentInput, { entitlements: plans, env: { MODEL_ID: 'model-a' } } as AgentInputs),
      ),
    ),
  )
  return { layer, reads: () => reads }
}

describe('the model budget the agent checks (R5)', () => {
  it.effect("counts today's spend against the plan's allowance, reading the plan once a minute", () => {
    const { layer, reads } = lane()
    return Effect.gen(function* () {
      const budget = yield* Budget
      const now = 86_400 * 20_000 + 60
      yield* budget.record({ input: 5000, output: 0, cacheRead: 0, cacheWrite: 0 }, now)
      expect(yield* budget.today(now)).toEqual({ used: 1, limit: 2, resetsAt: 86_400 * 20_001 })
      yield* budget.require(now)
      yield* budget.record({ input: 5000, output: 0, cacheRead: 0, cacheWrite: 0 }, now, 'model-a')
      expect(yield* Effect.flip(budget.require(now))).toMatchObject({ _tag: 'BudgetExhausted', limit: 2 })
      expect(reads()).toBe(1)
    }).pipe(Effect.provide(layer))
  })
})
