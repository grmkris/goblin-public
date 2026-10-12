import type { PayChoice, PayMode, PayRoute } from '@goblin/contracts'
import { eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import { Budget } from './budget.ts'
import { epochSeconds } from './clock.ts'
import { type AppError, InvalidInput } from './http/errors.ts'
import { reportAndRecover } from './observability/report.ts'
import { appPayMode } from './storage/pay.ts'

/** The owner's stored pay mode and route, if they chose one. */
export type PaySetting = { readonly mode: PayMode; readonly route: PayRoute }

/** The owner's choice (one row), if any. */
export interface PayLedger {
  get(): PaySetting | undefined
  set(setting: PaySetting, now: number): void
}

export class PayModeStore implements PayLedger {
  readonly #db: DrizzleSqliteDODatabase
  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db
  }

  get(): PaySetting | undefined {
    const row = this.#db.select().from(appPayMode).where(eq(appPayMode.id, 1)).get()
    return row === undefined ? undefined : { mode: row.mode, route: row.route }
  }

  set({ mode, route }: PaySetting, now: number): void {
    this.#db
      .insert(appPayMode)
      .values({ id: 1, mode, route, updatedAt: now })
      .onConflictDoUpdate({ target: appPayMode.id, set: { mode, route, updatedAt: now } })
      .run()
  }
}

/**
 * The pay choice as it stands: the stored one, else Credits first and then the wallet on goblin's own route. A route
 * the stage no longer sells falls back to goblin's (or the first it sells), and a stage that sells none pays every call
 * with Credits.
 */
export function payChoiceOf(
  stored: PaySetting | undefined,
  routes: readonly PayRoute[],
  walletReady: boolean,
): PayChoice {
  const fallback: PayRoute = routes.includes('goblin') ? 'goblin' : (routes[0] ?? 'goblin')
  const route = stored !== undefined && routes.includes(stored.route) ? stored.route : fallback
  const mode = routes.length === 0 ? 'credits' : (stored?.mode ?? 'credits-then-wallet')
  return { mode, route, routes, walletReady }
}

/** Stores the owner's pay mode and route; `InvalidInput` for a route the stage does not sell. */
export function choosePay(ledger: PayLedger, routes: readonly PayRoute[], setting: PaySetting, now: number): void {
  if (!routes.includes(setting.route)) throw new InvalidInput({ reason: 'pay_route' })
  ledger.set(setting, now)
}

/**
 * How goblin pays for the owner's model calls (ADR 0047): Credits first and then the owner's Goblin Wallet, Credits
 * only, or the wallet for every call, on one of the paid routes the stage sells. Routines and housekeeping always run
 * on Credits.
 */
export class Pay extends Context.Service<
  Pay,
  {
    /** The pay mode and route, the routes the stage sells, and whether the wallet can pay now. */
    readonly choice: Effect.Effect<PayChoice>
    /** Stores the mode and route (epoch seconds); `InvalidInput` for a route the stage does not sell. */
    readonly choose: (setting: PaySetting, now: number) => Effect.Effect<PayChoice, AppError>
  }
>()('goblin/pay/Pay') {}

/**
 * Whether the wallet pays once today's Credits are spent: always in `wallet` mode, and in `credits-then-wallet` while it
 * can pay. A stage that sells no route reads `credits` (`payChoiceOf`).
 */
export const walletPaysWhenSpent = (choice: PayChoice): boolean =>
  choice.mode === 'wallet' || (choice.mode === 'credits-then-wallet' && choice.walletReady)

/**
 * The paid route a conversation's model call goes out on now, or none for Credits: every call in `wallet` mode, and in
 * `credits-then-wallet` once today's Credits are spent while the wallet can pay. It is asked before each call, so a
 * turn whose Credits run out midway goes on paid. A failure to decide keeps the call on Credits, and is reported.
 */
export const payingRoute: Effect.Effect<PayRoute | undefined, never, Pay | Budget> = Effect.gen(function* () {
  const choice = yield* Pay.use((pay) => pay.choice)
  if (!walletPaysWhenSpent(choice)) return undefined
  if (choice.mode === 'wallet') return choice.route
  const today = yield* Budget.use((budget) => Effect.flatMap(epochSeconds, (now) => budget.today(now)))
  return today.used >= today.limit ? choice.route : undefined
}).pipe(reportAndRecover('pay.route', undefined))
