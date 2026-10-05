import type { UsageToday } from '@purrable/contracts'
import { eq, sql } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { BudgetExhausted } from './http/errors.ts'
import { appUsageDaily } from './storage/schema.ts'

const DAY_SECONDS = 86_400
/** Default for injected numeric native-fixture budgets; deployed allowances come from the account plan. */
export const DEFAULT_DAILY_TOKENS = 300_000

export const dailyTokenLimit = (value: string | undefined): number => {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_TOKENS
}

/** Optional per-model price multipliers. Missing or invalid entries keep the neutral weight of one. */
export const modelTokenWeights = (value: string | undefined): Readonly<Record<string, number>> => {
  if (value === undefined || value.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([model, weight]) => model.length > 0 && Number.isFinite(weight) && typeof weight === 'number' && weight > 0,
      ),
    )
  } catch {
    return {}
  }
}

/** The UTC day containing `now` (seconds) as `YYYY-MM-DD`, and when it ends. */
export const utcDay = (now: number): { readonly day: string; readonly resetsAt: number } => {
  const start = now - (now % DAY_SECONDS)
  return { day: new Date(start * 1000).toISOString().slice(0, 10), resetsAt: start + DAY_SECONDS }
}

/** Tokens spent per UTC day (the budget depends on this, not on SQLite). */
export interface UsageLedger {
  tokens(day: string): number
  add(day: string, tokens: number, now: number): void
}

export class UsageStore implements UsageLedger {
  readonly #db: DrizzleSqliteDODatabase
  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db
  }

  tokens(day: string): number {
    return this.#db.select().from(appUsageDaily).where(eq(appUsageDaily.day, day)).get()?.tokens ?? 0
  }

  add(day: string, tokens: number, now: number): void {
    this.#db
      .insert(appUsageDaily)
      .values({ day, tokens, updatedAt: now })
      .onConflictDoUpdate({
        target: appUsageDaily.day,
        set: { tokens: sql`${appUsageDaily.tokens} + ${tokens}`, updatedAt: now },
      })
      .run()
  }
}

/**
 * This agent's model budget: every model response's tokens (input, output and cache) count against the user's UTC
 * day. Users share one capped model key, so one user must not be able to spend it for everyone.
 */
export class ModelBudget {
  readonly #ledger: UsageLedger
  readonly #limit: number | ((now: number) => Promise<number>)
  readonly #weights: Readonly<Record<string, number>>
  constructor(
    ledger: UsageLedger,
    limit: number | ((now: number) => Promise<number>),
    weights: Readonly<Record<string, number>> = {},
  ) {
    this.#ledger = ledger
    this.#limit = limit
    this.#weights = weights
  }

  async today(now: number): Promise<UsageToday> {
    const { day, resetsAt } = utcDay(now)
    const limit = typeof this.#limit === 'number' ? this.#limit : await this.#limit(now)
    return { used: this.#ledger.tokens(day), limit, resetsAt }
  }

  record(tokens: number, now: number, model?: string): void {
    const weight = model === undefined ? 1 : (this.#weights[model] ?? 1)
    if (Number.isFinite(tokens) && tokens > 0) this.#ledger.add(utcDay(now).day, Math.ceil(tokens * weight), now)
  }

  /** Fails with `BudgetExhausted` once today's spend has reached the limit. */
  async require(now: number): Promise<void> {
    const today = await this.today(now)
    if (today.used >= today.limit) throw new BudgetExhausted({ limit: today.limit, resetsAt: today.resetsAt })
  }
}
