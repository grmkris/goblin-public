import { afterEach, describe, expect, it } from 'vitest'
import { SpendStore, dayOf, dollars, microsOf, ruleText, withinRule } from '../../src/mcp/spend.ts'
import { chatDatabase, durable } from '../chats-sqlite.ts'

const open: { close: () => void }[] = []
afterEach(() => {
  for (const database of open.splice(0)) database.close()
})

/** A spend store over real SQLite with the application migrations applied. */
const store = () => {
  const database = chatDatabase()
  open.push(database)
  return new SpendStore(durable(database.db))
}

const NOW = Date.parse('2026-10-12T10:00:00Z')
/** A paid Mercator job held as `id`, for `micros`. */
const job = (id: string, micros: number, standing = true) => ({
  approvalId: id,
  connectionId: 'mercator',
  tool: 'create_job',
  micros,
  standing,
})

describe('spending rules for paid tools (ADR 0044)', () => {
  it('reads an amount as whole micro-dollars from a plain decimal only', () => {
    expect(microsOf('1.25')).toBe(1_250_000)
    expect(microsOf('5')).toBe(5_000_000)
    expect(microsOf('0.000001')).toBe(1)
    expect(microsOf('999999999.999999')).toBe(999_999_999_999_999)
    for (const bad of ['', '1.2345678', '-1', '1e3', ' 1', '1,5', '0x10', '1000000000'])
      expect(microsOf(bad), bad).toBeUndefined()
    expect(microsOf(1.25)).toBeUndefined()
    expect(microsOf(undefined)).toBeUndefined()
  })

  it('writes amounts as the owner reads them, and a rule as the model reads it', () => {
    expect([dollars(5_000_000), dollars(1_250_000), dollars(1_500_000), dollars(4_000)]).toEqual([
      '$5',
      '$1.25',
      '$1.50',
      '$0.004',
    ])
    expect(ruleText({ perJob: 5_000_000, daily: 20_000_000 })).toBe('asks above $5 a job or past $20 today')
    expect(ruleText({ perJob: 2_500_000 })).toBe('asks above $2.50 a job')
  })

  it('runs a job without asking only at or under the per-job limit and within the day', () => {
    const rule = { perJob: 5_000_000, daily: 20_000_000 }
    expect(withinRule(rule, 5_000_000, 0)).toBe(true)
    expect(withinRule(rule, 5_000_001, 0)).toBe(false)
    expect(withinRule(rule, 5_000_000, 15_000_000)).toBe(true)
    expect(withinRule(rule, 5_000_000, 15_000_001)).toBe(false)
    expect(withinRule({ perJob: 5_000_000 }, 5_000_000, 1e12)).toBe(true)
    expect(withinRule(undefined, 1, 0)).toBe(false)
    expect(withinRule(rule, undefined, 0)).toBe(false)
  })

  it('keeps the day under its total however the calls come, and counts each held call once', () => {
    const spend = store()
    spend.setRule('mercator', 'create_job', { perJob: 5_000_000, daily: 8_000_000 }, NOW)
    const rule = spend.rule('mercator', 'create_job')
    expect(rule).toEqual({ perJob: 5_000_000, daily: 8_000_000 })
    expect(spend.record(job('a', 4_000_000), NOW, rule)).toBe(true)
    expect(spend.record(job('a', 4_000_000), NOW, rule)).toBe(true)
    expect(spend.spentOn('mercator', 'create_job', dayOf(NOW))).toBe(4_000_000)
    // The next one would pass the day's total: refused, nothing recorded.
    expect(spend.record(job('b', 4_500_000), NOW, rule)).toBe(false)
    expect(spend.standing('b')).toBe(false)
    // One the owner approved counts toward the day, whatever the rule says.
    expect(spend.record(job('c', 4_500_000, false), NOW)).toBe(true)
    expect(spend.spentOn('mercator', 'create_job', dayOf(NOW))).toBe(8_500_000)
    expect([spend.standing('a'), spend.standing('c')]).toEqual([true, false])
    // A new day starts from nothing.
    expect(spend.record(job('d', 5_000_000), NOW + 86_400_000, rule)).toBe(true)
    spend.setRule('mercator', 'create_job', undefined, NOW)
    expect(spend.rule('mercator', 'create_job')).toBeUndefined()
  })
})
