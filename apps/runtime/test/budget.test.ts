import { describe, expect, it } from 'vitest'
import { ModelBudget, type UsageLedger, utcDay } from '../src/budget.ts'
import { DEFAULT_RATES, type TokenUse, creditRates, milliCredits, rateFor } from '../src/budget-credits.ts'

class MemoryLedger implements UsageLedger {
  readonly days = new Map<string, { tokens: number; milli: number }>()
  milliCredits(day: string): number {
    return this.days.get(day)?.milli ?? 0
  }
  add(day: string, tokens: number, milli: number): void {
    const now = this.days.get(day) ?? { tokens: 0, milli: 0 }
    this.days.set(day, { tokens: now.tokens + tokens, milli: now.milli + milli })
  }
}

const use = (input: number, output = 0, cacheRead = 0): TokenUse => ({ input, output, cacheRead, cacheWrite: 0 })

// 2026-10-04T23:59:30Z and 40 seconds later, across UTC midnight.
const BEFORE_MIDNIGHT = 1_791_158_370
const AFTER_MIDNIGHT = BEFORE_MIDNIGHT + 40

describe('per-user model budget (unit, ADR 0026)', () => {
  it('keys spend by UTC day and resets at midnight', () => {
    expect(utcDay(BEFORE_MIDNIGHT)).toEqual({ day: '2026-10-04', resetsAt: 1_791_158_400 })
    expect(utcDay(AFTER_MIDNIGHT).day).toBe('2026-10-05')
  })

  it('counts Credits, refuses once the day is spent, and allows again the next day', async () => {
    const ledger = new MemoryLedger()
    const budget = new ModelBudget(ledger, 2)
    // 5,000 fresh input tokens are one Credit at the default rate.
    budget.record(use(5000), BEFORE_MIDNIGHT)
    await expect(budget.require(BEFORE_MIDNIGHT)).resolves.toBeUndefined()
    budget.record(use(0, 830), BEFORE_MIDNIGHT)
    expect(await budget.today(BEFORE_MIDNIGHT)).toEqual({ used: 2, limit: 2, resetsAt: 1_791_158_400 })
    expect(ledger.days.get('2026-10-04')).toEqual({ tokens: 5830, milli: 2000 })
    await expect(budget.require(BEFORE_MIDNIGHT)).rejects.toMatchObject({
      _tag: 'BudgetExhausted',
      limit: 2,
      resetsAt: 1_791_158_400,
    })
    await expect(budget.require(AFTER_MIDNIGHT)).resolves.toBeUndefined()
  })

  it('ignores responses that report no usage', () => {
    const ledger = new MemoryLedger()
    const budget = new ModelBudget(ledger, 10)
    budget.record(use(0), BEFORE_MIDNIGHT)
    budget.record(use(Number.NaN), BEFORE_MIDNIGHT)
    budget.record(use(-5), BEFORE_MIDNIGHT)
    expect(ledger.days.size).toBe(0)
  })

  it('re-reads account limits and prices each model at its rate, leaving another ledger untouched', async () => {
    let allowance = 3
    const rates = creditRates('{"models":{"glm-5.3":{"input":2500,"cached":25000,"output":400}}}')
    const first = new ModelBudget(new MemoryLedger(), async () => allowance, rates)
    const second = new ModelBudget(new MemoryLedger(), async () => 999)
    first.record(use(5000), BEFORE_MIDNIGHT, 'glm-5.3')
    expect(await first.today(BEFORE_MIDNIGHT)).toMatchObject({ used: 2, limit: 3 })
    expect(await second.today(BEFORE_MIDNIGHT)).toMatchObject({ used: 0, limit: 999 })
    allowance = 2
    await expect(first.require(BEFORE_MIDNIGHT)).rejects.toMatchObject({ _tag: 'BudgetExhausted', limit: 2 })
  })
})

describe('Credit rates (unit, ADR 0026)', () => {
  it("price cached input at a tenth of fresh input and output at about six times, as Alibaba's example does", () => {
    expect(milliCredits(use(5000), 'qwen3.8-flash', DEFAULT_RATES)).toBe(1000)
    expect(milliCredits(use(0, 0, 50_000), 'qwen3.8-flash', DEFAULT_RATES)).toBe(1000)
    expect(milliCredits(use(0, 830), 'qwen3.8-flash', DEFAULT_RATES)).toBe(1000)
    // A cached 40K-token prefix and a short answer cost a fraction of the same prompt uncached.
    expect(milliCredits(use(1000, 300, 40_000), 'qwen3.8-max', DEFAULT_RATES)).toBe(1362)
    expect(milliCredits(use(41_000, 300), 'qwen3.8-max', DEFAULT_RATES)).toBe(8562)
    expect(milliCredits(use(1), undefined, DEFAULT_RATES)).toBe(1)
    expect(milliCredits(use(0), undefined, DEFAULT_RATES)).toBe(0)
  })

  it('reads overrides and aliases, prices Gemini 3.8 Flash as Qwen 3.8 Flash, and keeps defaults for nonsense', () => {
    const rates = creditRates(
      '{"default":{"input":4000,"cached":40000,"output":800},"models":{"qwen3.8-flash":{"input":10000,"cached":100000,"output":1600},"bad":{"input":-1}},"aliases":{"other":"qwen3.8-flash"}}',
    )
    expect(rateFor('gemini-3.8-flash', rates)).toEqual({ input: 10_000, cached: 100_000, output: 1600 })
    expect(rateFor('other', rates)).toEqual({ input: 10_000, cached: 100_000, output: 1600 })
    expect(rateFor('bad', rates)).toEqual({ input: 4000, cached: 40_000, output: 800 })
    expect(rateFor('glm-5.3', rates)).toEqual({ input: 4000, cached: 40_000, output: 800 })
    expect(creditRates('garbage')).toBe(DEFAULT_RATES)
    expect(creditRates(undefined)).toBe(DEFAULT_RATES)
    expect(creditRates('{"default":{"input":0}}').default).toEqual(DEFAULT_RATES.default)
  })
})
