import { and, eq, sql } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { appMcpSpend as spend, appMcpSpendRules as rules } from '../storage/mcp-spend.ts'

// Spending rules for paid tools (ADR 0044): the owner's per-job and daily limits in goblin, and every paid call goblin
// sent, by the held call it went out as. Amounts are whole micro-dollars, never floating point.

/** A rule: jobs up to `perJob` run without asking, until the day's total would pass `daily`; micro-dollars. */
export type SpendRule = { readonly perJob: number; readonly daily?: number }

/**
 * A paid call to record: the held call it went out as, its tool, its amount, and whether it ran under the rule; for a
 * top-up (ADR 0049), where it goes (`<chain>:<token>:<address>`).
 */
export type Spent = {
  readonly approvalId: string
  readonly connectionId: string
  readonly tool: string
  readonly micros: number
  readonly standing: boolean
  readonly destination?: string
}

/** A paid call as recorded. */
export type SpentRow = Spent & { readonly day: string; readonly at: number }

/** A plain decimal amount: digits, then at most six after a point. */
const AMOUNT = /^(\d{1,9})(?:\.(\d{1,6}))?$/u

/** An amount in whole micro-dollars, from the decimal string a paid tool takes; nothing for anything else. */
export const microsOf = (value: unknown): number | undefined => {
  if (typeof value !== 'string') return undefined
  const match = AMOUNT.exec(value)
  if (match === null) return undefined
  const [, whole = '0', fraction = ''] = match
  return Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'))
}

/** An amount in micro-dollars as dollars and cents for the owner, and the model: `$5`, `$1.25`, `$0.004`. */
export const dollars = (micros: number): string => {
  const whole = Math.floor(micros / 1_000_000)
  const fraction = String(micros % 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/u, '')
  return `$${String(whole)}${fraction === '' ? '' : `.${fraction.length === 1 ? `${fraction}0` : fraction}`}`
}

/** The UTC day a call counts toward. */
export const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10)

/**
 * Whether a paid call of `micros` may run under `rule` without asking, with `spentToday` already spent that day: at or
 * under the per-job limit, and the day's total, with it, at or under the daily one. No amount, no rule: it asks.
 */
export const withinRule = (rule: SpendRule | undefined, micros: number | undefined, spentToday: number): boolean =>
  rule !== undefined &&
  micros !== undefined &&
  micros <= rule.perJob &&
  (rule.daily === undefined || spentToday + micros <= rule.daily)

/** How a rule reads to the model: "asks above $5 a job or past $20 today". */
export const ruleText = (rule: SpendRule): string =>
  `asks above ${dollars(rule.perJob)} a job${rule.daily === undefined ? '' : ` or past ${dollars(rule.daily)} today`}`

/** Spending rules and paid calls, in the agent's application tables. Every method is synchronous and short. */
export class SpendStore {
  readonly #db: DrizzleSqliteDODatabase
  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db
  }

  rule(connectionId: string, tool: string): SpendRule | undefined {
    const row = this.#db
      .select()
      .from(rules)
      .where(and(eq(rules.connectionId, connectionId), eq(rules.tool, tool)))
      .get()
    if (row?.perJobMicros === null || row?.perJobMicros === undefined) return undefined
    return { perJob: row.perJobMicros, ...(row.dailyMicros === null ? {} : { daily: row.dailyMicros }) }
  }

  /** Sets the rule for a paid tool, or removes it (`undefined`: the tool asks first again). */
  setRule(connectionId: string, tool: string, rule: SpendRule | undefined, now: number): void {
    if (rule === undefined) {
      this.#db
        .delete(rules)
        .where(and(eq(rules.connectionId, connectionId), eq(rules.tool, tool)))
        .run()
      return
    }
    const values = { perJobMicros: rule.perJob, dailyMicros: rule.daily ?? null, updatedAt: now }
    this.#db
      .insert(rules)
      .values({ connectionId, tool, ...values })
      .onConflictDoUpdate({ target: [rules.connectionId, rules.tool], set: values })
      .run()
  }

  /** What the tool's paid calls came to on `day`, in micro-dollars. */
  spentOn(connectionId: string, tool: string, day: string): number {
    return (
      this.#db
        .select({ total: sql<number>`coalesce(sum(${spend.micros}), 0)` })
        .from(spend)
        .where(and(eq(spend.connectionId, connectionId), eq(spend.tool, tool), eq(spend.day, day)))
        .get()?.total ?? 0
    )
  }

  /** Whether held call `approvalId` was recorded as running under the rule. */
  standing(approvalId: string): boolean {
    return this.#db.select().from(spend).where(eq(spend.approvalId, approvalId)).get()?.standing === true
  }

  /** The paid call recorded as `approvalId`, if any. */
  find(approvalId: string): SpentRow | undefined {
    const row = this.#db.select().from(spend).where(eq(spend.approvalId, approvalId)).get()
    if (row === undefined) return undefined
    const { destination, ...rest } = row
    return { ...rest, ...(destination === null ? {} : { destination }) }
  }

  /** How many paid calls of the tool were ever recorded: a top-up's operation is numbered after them (ADR 0049). */
  count(connectionId: string, tool: string): number {
    return (
      this.#db
        .select({ count: sql<number>`count(*)` })
        .from(spend)
        .where(and(eq(spend.connectionId, connectionId), eq(spend.tool, tool)))
        .get()?.count ?? 0
    )
  }

  /**
   * Records a paid call against its day, once per held call. With `rule`, only when it still fits: the check and the
   * record are one transaction, so two calls at once cannot both fit under the day's total. True when it is recorded.
   */
  record(call: Spent, now: number, rule?: SpendRule): boolean {
    return this.#db.transaction((tx) => {
      if (tx.select().from(spend).where(eq(spend.approvalId, call.approvalId)).get() !== undefined) return true
      const day = dayOf(now)
      if (rule !== undefined) {
        const spent =
          tx
            .select({ total: sql<number>`coalesce(sum(${spend.micros}), 0)` })
            .from(spend)
            .where(and(eq(spend.connectionId, call.connectionId), eq(spend.tool, call.tool), eq(spend.day, day)))
            .get()?.total ?? 0
        if (!withinRule(rule, call.micros, spent)) return false
      }
      tx.insert(spend)
        .values({ ...call, destination: call.destination ?? null, day, at: now })
        .run()
      return true
    })
  }
}
