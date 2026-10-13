import { describe, expect, it } from '@effect/vitest'
import type { PayMode, ServerView } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { afterEach } from 'vitest'
import type { EntitlementPolicy } from '../src/billing/gates.ts'
import type { AccountPlan } from '../src/billing/reconcile.ts'
import { Budget } from '../src/budget.ts'
import { epochSeconds } from '../src/clock.ts'
import { ModelBudgetLive } from '../src/layers/budget.ts'
import { EntitlementsLive } from '../src/layers/core.ts'
import { Models } from '../src/models.ts'
import { Pay, PayModeStore, payingRoute } from '../src/pay-mode.ts'
import { AgentInput, type AgentInputs } from '../src/runtime/input.ts'
import { McpConnections, McpGrants, McpServers } from '../src/mcp/service.ts'
import { stub } from './http/api/fixture.ts'
import { chatDatabase, durable, sqliteDb } from './chats-sqlite.ts'

const PLAN: AccountPlan = {
  active: true,
  plan: 'pro',
  source: 'override',
  billing: null,
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

/** The owner's Goblin Wallet as the host lists it: signed in, or not. */
const walletServer = (status: ServerView['status']): ServerView => ({
  connectionId: 'w1',
  label: 'Goblin Wallet',
  endpoint: 'https://wallet-dev.goblin.surf/mcp',
  status,
  live: status === 'connected',
  source: 'added',
})

/** How the wallet's payment tool is allowed: to run, to ask first, or not at all. */
type Grant = 'run' | 'ask' | 'none'

/**
 * The lane's layer over SQLite, with an account plan whose reads (auth D1) are counted, a stage that sells `paid`
 * routes, and the owner's wallet as `wallet` says (none by default).
 */
const lane = (
  options: {
    readonly paid?: string
    readonly wallet?: ServerView['status']
    readonly grant?: Grant
    readonly plan?: AccountPlan
  } = {},
) => {
  const { db, close } = chatDatabase()
  closes.push(close)
  let reads = 0
  let days = 0
  const state = Effect.sync(() => {
    reads += 1
    return options.plan ?? PLAN
  })
  const plans: EntitlementPolicy = {
    state: () => state,
    require: () => state,
    payDay: () =>
      Effect.sync(() => {
        days += 1
        return 'settled' as const
      }),
  }
  const servers = options.wallet === undefined ? [] : [walletServer(options.wallet)]
  const grant = options.grant ?? 'none'
  const layer = ModelBudgetLive.pipe(
    Layer.provideMerge(EntitlementsLive),
    Layer.provide(
      Layer.mergeAll(
        sqliteDb(db),
        stub(McpServers, { list: () => Effect.succeed(servers) }),
        stub(McpConnections),
        stub(McpGrants, {
          policy: (_connectionId, name) =>
            Effect.succeed(
              name === 'pay_challenge' && grant !== 'none'
                ? Option.some({ askFirst: grant === 'ask', version: 'v1' })
                : Option.none(),
            ),
        }),
        // SAFETY: the budget, the kept plan, the pay mode and the picker read only these from the instance input.
        Layer.succeed(AgentInput, {
          entitlements: plans,
          env: { MODEL_ID: 'model-a', PAID_INFERENCE: options.paid ?? 'goblin,tempo' },
        } as AgentInputs),
      ),
    ),
  )
  return { layer, reads: () => reads, days: () => days, db }
}

const NOW = 86_400 * 20_000 + 60
const TOKENS = { input: 10_000, output: 0, cacheRead: 0, cacheWrite: 0 }

/** Spends the day's two Credits, then answers whether a turn is admitted and the route the next call takes. */
const spentDay = (mode: PayMode | undefined) =>
  Effect.gen(function* () {
    const budget = yield* Budget
    // The route is decided at the clock's now, as each model call asks it.
    const now = yield* epochSeconds
    if (mode !== undefined) yield* Pay.use((pay) => pay.choose({ mode, route: 'goblin' }, now))
    const before = yield* payingRoute
    yield* budget.record(TOKENS, now)
    const admitted = yield* budget.admit(now).pipe(
      Effect.as('admitted'),
      Effect.catchTag('BudgetExhausted', () => Effect.succeed('refused')),
    )
    const credits = yield* budget.require(now).pipe(
      Effect.as('admitted'),
      Effect.catchTag('BudgetExhausted', () => Effect.succeed('refused')),
    )
    return { admitted, credits, before, after: yield* payingRoute }
  })

describe('the model budget the agent checks (R5)', () => {
  it.effect(
    'refuses a turn, a tool and routine work without a plan as `chat`, and shows no allowance (ADR 0054)',
    () => {
      const none: AccountPlan = { ...PLAN, active: false, plan: null, source: 'none', dailyCredits: 0 }
      const { layer, days } = lane({ plan: none })
      return Effect.gen(function* () {
        const budget = yield* Budget
        for (const check of [budget.admit(NOW), budget.open(NOW), budget.require(NOW)])
          expect(yield* Effect.flip(check)).toMatchObject({ _tag: 'SubscriptionRequired', feature: 'chat' })
        expect(yield* budget.today(NOW)).toMatchObject({ used: 0, limit: 0 })
        expect(days()).toBe(0)
      }).pipe(Effect.provide(layer))
    },
  )

  it.effect(
    "pays a day pass's day on the first turn of a UTC day, once, and never on a tool's check (ADR 0054)",
    () => {
      const { layer, days } = lane({ plan: { ...PLAN, source: 'wallet', billing: 'day' } })
      return Effect.gen(function* () {
        const budget = yield* Budget
        yield* budget.open(NOW)
        yield* Effect.yieldNow
        expect(days()).toBe(0)
        yield* budget.admit(NOW)
        yield* budget.admit(NOW + 3600)
        yield* Effect.yieldNow
        expect(days()).toBe(1)
        yield* budget.admit(NOW + 86_400)
        yield* Effect.yieldNow
        expect(days()).toBe(2)
      }).pipe(Effect.provide(layer))
    },
  )

  it.effect('never pays a day on monthly or an override', () => {
    const { layer, days } = lane({ plan: { ...PLAN, source: 'wallet', billing: 'month' } })
    return Effect.gen(function* () {
      yield* Budget.use((budget) => budget.admit(NOW))
      yield* Effect.yieldNow
      expect(days()).toBe(0)
    }).pipe(Effect.provide(layer))
  })

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

describe('how goblin pays for its model (ADR 0047)', () => {
  it.effect("starts on Credits then the wallet, on goblin's own route, else the first route the stage sells", () =>
    Effect.gen(function* () {
      expect(yield* Pay.use((pay) => pay.choice).pipe(Effect.provide(lane().layer))).toEqual({
        mode: 'credits-then-wallet',
        route: 'goblin',
        routes: ['goblin', 'tempo'],
        walletReady: false,
      })
      const tempo = yield* Pay.use((pay) => pay.choice).pipe(Effect.provide(lane({ paid: 'tempo' }).layer))
      expect(tempo).toMatchObject({ mode: 'credits-then-wallet', route: 'tempo', routes: ['tempo'] })
      // A stage that sells no route pays every call with Credits.
      const none = yield* Pay.use((pay) => pay.choice).pipe(Effect.provide(lane({ paid: '' }).layer))
      expect(none).toMatchObject({ mode: 'credits', routes: [] })
    }),
  )

  it.effect('is ready to pay only with the wallet signed in and its payment tool allowed to run without asking', () =>
    Effect.gen(function* () {
      const ready = (wallet: ServerView['status'], grant: Grant) =>
        Pay.use((pay) => pay.choice).pipe(
          Effect.map((choice) => choice.walletReady),
          Effect.provide(lane({ wallet, grant }).layer),
        )
      expect(yield* ready('connected', 'run')).toBe(true)
      expect(yield* ready('connected', 'ask')).toBe(false)
      expect(yield* ready('connected', 'none')).toBe(false)
      expect(yield* ready('needs_auth', 'run')).toBe(false)
    }),
  )

  it.effect('stores a choice, and refuses a route the stage does not sell', () => {
    const { layer } = lane({ paid: 'goblin' })
    return Effect.gen(function* () {
      const pay = yield* Pay
      expect(yield* pay.choose({ mode: 'wallet', route: 'goblin' }, NOW)).toMatchObject({ mode: 'wallet' })
      expect(yield* Effect.flip(pay.choose({ mode: 'wallet', route: 'tempo' }, NOW))).toMatchObject({
        _tag: 'InvalidInput',
        reason: 'pay_route',
      })
      expect(yield* pay.choice).toMatchObject({ mode: 'wallet', route: 'goblin' })
    }).pipe(Effect.provide(layer))
  })

  it.effect('credits then wallet: past the Credits a turn goes on paid while the wallet can pay, else it stops', () =>
    Effect.gen(function* () {
      const ready = yield* spentDay(undefined).pipe(Effect.provide(lane({ wallet: 'connected', grant: 'run' }).layer))
      expect(ready).toEqual({ admitted: 'admitted', credits: 'refused', before: undefined, after: 'goblin' })
      const unready = yield* spentDay(undefined).pipe(Effect.provide(lane({ wallet: 'connected' }).layer))
      expect(unready).toEqual({ admitted: 'refused', credits: 'refused', before: undefined, after: undefined })
    }),
  )

  it.effect("credits only: a turn stops at the day's limit even with a wallet that could pay", () =>
    Effect.gen(function* () {
      const result = yield* spentDay('credits').pipe(Effect.provide(lane({ wallet: 'connected', grant: 'run' }).layer))
      expect(result).toEqual({ admitted: 'refused', credits: 'refused', before: undefined, after: undefined })
    }),
  )

  it.effect(
    "wallet only: every call is paid and a turn is never held to the Credits, which goblin's own work keeps",
    () =>
      Effect.gen(function* () {
        const result = yield* spentDay('wallet').pipe(Effect.provide(lane().layer))
        expect(result).toEqual({ admitted: 'admitted', credits: 'refused', before: 'goblin', after: 'goblin' })
      }),
  )

  it('turns a stored paid model pick into the wallet pay mode on that route, and the pick into the default model', () => {
    const { db, migrate, close } = chatDatabase({ through: '20261031000100_mcp_spend' })
    closes.push(close)
    db.run("INSERT INTO app_model_choice (id, model_id, updated_at) VALUES (1, 'paid:tempo', 5)")
    migrate({ after: '20261031000100_mcp_spend' })
    expect(new PayModeStore(durable(db)).get()).toEqual({ mode: 'wallet', route: 'tempo' })
    expect(db.all('SELECT model_id FROM app_model_choice')).toEqual([])
  })

  it.effect('leaves the model pick a model: paid routes are not among the options', () =>
    Effect.gen(function* () {
      const choice = yield* Models.use((models) => models.choice).pipe(Effect.provide(lane().layer))
      expect(choice.options.map((option) => option.id)).toEqual(['model-a'])
    }),
  )
})
