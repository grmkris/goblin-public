import type { UsageToday } from '@purrable/contracts'
import { eq, sql } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { BudgetExhausted } from './http/errors.ts'
import { appUsageDaily } from './storage/schema.ts'

const DAY_SECONDS = 86_400
/** Model tokens a user's agent may spend per UTC day when `MODEL_DAILY_TOKENS` is not set. */
export const DEFAULT_DAILY_TOKENS = 300_000

export const dailyTokenLimit = (value: string | undefined): number => {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_TOKENS
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
  readonly #limit: number
  constructor(ledger: UsageLedger, limit: number) {
    this.#ledger = ledger
    this.#limit = limit
  }

  today(now: number): UsageToday {
    const { day, resetsAt } = utcDay(now)
    return { used: this.#ledger.tokens(day), limit: this.#limit, resetsAt }
  }

  record(tokens: number, now: number): void {
    if (Number.isFinite(tokens) && tokens > 0) this.#ledger.add(utcDay(now).day, Math.round(tokens), now)
  }

  /** Fails with `BudgetExhausted` once today's spend has reached the limit. */
  require(now: number): void {
    const today = this.today(now)
    if (today.used >= today.limit) throw new BudgetExhausted({ limit: today.limit, resetsAt: today.resetsAt })
  }
}
