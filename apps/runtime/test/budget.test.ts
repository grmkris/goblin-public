import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DAILY_TOKENS,
  ModelBudget,
  type UsageLedger,
  dailyTokenLimit,
  modelTokenWeights,
  utcDay,
} from '../src/budget.ts'

class MemoryLedger implements UsageLedger {
  readonly days = new Map<string, number>()
  tokens(day: string): number {
    return this.days.get(day) ?? 0
  }
  add(day: string, tokens: number): void {
    this.days.set(day, this.tokens(day) + tokens)
  }
}

// 2026-10-04T23:59:30Z and 40 seconds later, across UTC midnight.
const BEFORE_MIDNIGHT = 1_791_158_370
const AFTER_MIDNIGHT = BEFORE_MIDNIGHT + 40

describe('per-user model budget (unit)', () => {
  it('keys spend by UTC day and resets at midnight', () => {
    expect(utcDay(BEFORE_MIDNIGHT)).toEqual({ day: '2026-10-04', resetsAt: 1_791_158_400 })
    expect(utcDay(AFTER_MIDNIGHT).day).toBe('2026-10-05')
  })

  it('refuses once the day is spent, and allows again the next day', async () => {
    const ledger = new MemoryLedger()
    const budget = new ModelBudget(ledger, 1000)
    budget.record(600, BEFORE_MIDNIGHT)
    await expect(budget.require(BEFORE_MIDNIGHT)).resolves.toBeUndefined()
    budget.record(450, BEFORE_MIDNIGHT)
    expect(await budget.today(BEFORE_MIDNIGHT)).toEqual({ used: 1050, limit: 1000, resetsAt: 1_791_158_400 })
    await expect(budget.require(BEFORE_MIDNIGHT)).rejects.toMatchObject({
      _tag: 'BudgetExhausted',
      limit: 1000,
      resetsAt: 1_791_158_400,
    })
    await expect(budget.require(AFTER_MIDNIGHT)).resolves.toBeUndefined()
  })

  it('ignores responses that report no usage and rejects nonsense limits', () => {
    const ledger = new MemoryLedger()
    const budget = new ModelBudget(ledger, 10)
    budget.record(0, BEFORE_MIDNIGHT)
    budget.record(Number.NaN, BEFORE_MIDNIGHT)
    budget.record(-5, BEFORE_MIDNIGHT)
    expect(ledger.days.size).toBe(0)
    expect([
      dailyTokenLimit('5000'),
      dailyTokenLimit(undefined),
      dailyTokenLimit('0'),
      dailyTokenLimit('lots'),
    ]).toEqual([5000, DEFAULT_DAILY_TOKENS, DEFAULT_DAILY_TOKENS, DEFAULT_DAILY_TOKENS])
  })
  it('re-reads account limits and weights model tokens, leaving another ledger untouched', async () => {
    let allowance = 100
    const first = new ModelBudget(new MemoryLedger(), async () => allowance, modelTokenWeights('{"expensive":2}'))
    const second = new ModelBudget(new MemoryLedger(), async () => 999)
    first.record(30, BEFORE_MIDNIGHT, 'expensive')
    expect(await first.today(BEFORE_MIDNIGHT)).toMatchObject({ used: 60, limit: 100 })
    expect(await second.today(BEFORE_MIDNIGHT)).toMatchObject({ used: 0, limit: 999 })
    allowance = 50
    await expect(first.require(BEFORE_MIDNIGHT)).rejects.toMatchObject({ _tag: 'BudgetExhausted', limit: 50 })
    expect(modelTokenWeights('{"invalid":-1,"fine":0.5}')).toEqual({ fine: 0.5 })
    expect(modelTokenWeights('garbage')).toEqual({})
  })
})
