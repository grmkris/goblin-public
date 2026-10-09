import type { UsageToday } from '@goblin/contracts'
import { eq, sql } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import { type CreditRates, DEFAULT_RATES, type TokenUse, milliCredits, totalTokens } from './budget-credits.ts'
import { type AppError, BudgetExhausted } from './http/errors.ts'
import { appUsageDaily } from './storage/schema.ts'

const DAY_SECONDS = 86_400

/** The UTC day containing `now` (seconds) as `YYYY-MM-DD`, and when it ends. */
export const utcDay = (now: number): { readonly day: string; readonly resetsAt: number } => {
  const start = now - (now % DAY_SECONDS)
  return { day: new Date(start * 1000).toISOString().slice(0, 10), resetsAt: start + DAY_SECONDS }
}

/** What the agent spent per UTC day: tokens, and thousandths of a Credit, which the budget counts. */
export interface UsageLedger {
  milliCredits(day: string): number
  add(day: string, tokens: number, milli: number, now: number): void
}

export class UsageStore implements UsageLedger {
  readonly #db: DrizzleSqliteDODatabase
  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db
  }

  milliCredits(day: string): number {
    return this.#db.select().from(appUsageDaily).where(eq(appUsageDaily.day, day)).get()?.milliCredits ?? 0
  }

  add(day: string, tokens: number, milli: number, now: number): void {
    this.#db
      .insert(appUsageDaily)
      .values({ day, tokens, milliCredits: milli, updatedAt: now })
      .onConflictDoUpdate({
        target: appUsageDaily.day,
        set: {
          tokens: sql`${appUsageDaily.tokens} + ${tokens}`,
          milliCredits: sql`${appUsageDaily.milliCredits} + ${milli}`,
          updatedAt: now,
        },
      })
      .run()
  }
}

/**
 * This agent's model budget in estimated Token Plan Credits (ADR 0026): every model response counts against the
 * user's UTC day at its model's rate, fresh input, cached input and output each priced as the plan prices them. Users
 * share one capped model key, so one user must not be able to spend it for everyone.
 */
export class ModelBudget {
  readonly #ledger: UsageLedger
  readonly #limit: number | ((now: number) => Promise<number>)
  readonly #rates: CreditRates
  /** `limit` is in Credits. */
  constructor(
    ledger: UsageLedger,
    limit: number | ((now: number) => Promise<number>),
    rates: CreditRates = DEFAULT_RATES,
  ) {
    this.#ledger = ledger
    this.#limit = limit
    this.#rates = rates
  }

  /** Today's spend and allowance, in Credits. */
  async today(now: number): Promise<UsageToday> {
    const { day, resetsAt } = utcDay(now)
    const limit = typeof this.#limit === 'number' ? this.#limit : await this.#limit(now)
    return { used: this.#ledger.milliCredits(day) / 1000, limit, resetsAt }
  }

  record(use: TokenUse, now: number, model?: string): void {
    const tokens = totalTokens(use)
    if (!Number.isFinite(tokens) || tokens <= 0) return
    this.#ledger.add(utcDay(now).day, tokens, milliCredits(use, model, this.#rates), now)
  }

  /** Fails with `BudgetExhausted` once today's spend has reached the limit. */
  async require(now: number): Promise<void> {
    const today = await this.today(now)
    if (today.used >= today.limit) throw new BudgetExhausted({ limit: today.limit, resetsAt: today.resetsAt })
  }
}

/** The agent's daily model budget in Credits (ADR 0026), as the programs use it. Instants are epoch seconds. */
export class Budget extends Context.Service<
  Budget,
  {
    /** Today's spend and allowance; the allowance is the account plan's. */
    readonly today: (now: number) => Effect.Effect<UsageToday, AppError>
    /** One model response's tokens, priced at `model`'s rate. */
    readonly record: (use: TokenUse, now: number, model?: string) => Effect.Effect<void>
    /** `BudgetExhausted` once today's spend has reached the allowance. */
    readonly require: (now: number) => Effect.Effect<void, AppError>
  }
>()('goblin/budget/Budget') {}

/** `BudgetExhausted` once the agent has spent today's model budget. */
export const requireBudget: Effect.Effect<void, AppError, Budget> = Effect.flatMap(Clock.currentTimeMillis, (millis) =>
  Budget.use((budget) => budget.require(Math.floor(millis / 1000))),
)
