import type { WalletStatus } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'
import { Entitlements } from '../billing/gates.ts'
import { Budget, recordUse, usageLedger, utcDay } from '../budget.ts'
import { creditRates } from '../budget-credits.ts'
import { BudgetExhausted, attemptSync } from '../http/errors.ts'
import { ModelChoiceStore, ModelPicker, Models, modelOptions, paidRoutes } from '../models.ts'
import { Pay, PayModeStore, choosePay, payChoiceOf, walletPaysWhenSpent } from '../pay-mode.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'
import { profileOf } from '../mcp/first-class.ts'
import { McpGrants, McpServers } from '../mcp/service.ts'
import { background } from '../observability/background.ts'

/** A decimal amount as dollars; anything unreadable is none. */
const dollars = (value: string | undefined): number => {
  const amount = Number(value)
  return Number.isFinite(amount) ? amount : 0
}

/**
 * The dollars of stablecoins a Goblin Wallet holds: the total its status adds up on every chain, else what its status
 * line's USDC and USDC.e come to, owner and agent together. A partial total counts what was read.
 */
export const stablecoinDollars = (status: WalletStatus): number =>
  status.stablecoinUsd !== undefined
    ? dollars(status.stablecoinUsd)
    : status.tokens
        .filter((token) => token.symbol === 'USDC' || token.symbol === 'USDC.e')
        .reduce((sum, token) => sum + dollars(token.balance), 0)

type Method<Args extends readonly unknown[], A> = (...args: Args) => A

/** A store method that throws its typed failures: an `AppError` (anything else `Internal`), never a defect. */
const trySync = <Args extends readonly unknown[], A>(name: string, method: Method<Args, A>) =>
  Effect.fn(name)(function* (...args: Args) {
    return yield* attemptSync(() => method(...args))
  })

/** A method with no typed failure: a read callers run with `useSync`, where a throw is a defect. */
const sync = <Args extends readonly unknown[], A>(name: string, method: Method<Args, A>) =>
  Effect.fn(name)(function* (...args: Args) {
    return yield* Effect.sync(() => method(...args))
  })

/**
 * Whether the owner's Goblin Wallet can pay a model call now: connected, with its payment tool (its profile's
 * `payment`) allowed to run without asking. Read from the agent's own stores, never the wallet.
 */
const walletReady = Effect.gen(function* () {
  const servers = yield* McpServers.use((owner) => owner.list())
  const grants = yield* McpGrants
  for (const server of servers) {
    const tool = profileOf(server.endpoint)?.payment?.tool
    if (server.status !== 'connected' || tool === undefined) continue
    const policy = yield* grants.policy(server.connectionId, tool)
    if (Option.isSome(policy) && !policy.value.askFirst) return true
  }
  return false
})

/** How goblin pays for the owner's model calls (ADR 0047), over the agent's SQLite and the MCP host's grants. */
const PayLive: Layer.Layer<Pay, never, AgentInput | Db | McpServers | McpGrants> = Layer.effect(
  Pay,
  Effect.gen(function* () {
    const { env } = yield* AgentInput
    const store = new PayModeStore(yield* Db)
    const routes = paidRoutes(env.PAID_INFERENCE).map((route) => route.name)
    const ready = walletReady.pipe(
      Effect.provideService(McpServers, yield* McpServers),
      Effect.provideService(McpGrants, yield* McpGrants),
    )
    const choice = Effect.gen(function* () {
      const stored = yield* Effect.sync(() => store.get())
      return payChoiceOf(stored, routes, yield* ready)
    }).pipe(Effect.withSpan('Pay.choice'))
    return Pay.of({
      choice,
      choose: Effect.fn('Pay.choose')(function* (setting, now) {
        yield* attemptSync(() => choosePay(store, routes, setting, now))
        return yield* choice
      }),
    })
  }),
)

/**
 * The daily model budget in Credits (ADR 0026) over the agent's usage ledger. The allowance is the plan's, read from
 * the plan the agent keeps (`Entitlements`), so a tool call no longer reads auth D1 each time. Without a plan nothing
 * spends: there is no free plan (ADR 0054, amended 2026-10-13), so every check refuses with `SubscriptionRequired`.
 */
const BudgetLive = Layer.effect(
  Budget,
  Effect.gen(function* () {
    const db = yield* Db
    const ledger = usageLedger(db)
    const plans = yield* Entitlements
    const pay = yield* Pay
    const { env } = yield* AgentInput
    const rates = creditRates(env.MODEL_CREDIT_RATES)
    /** The UTC day (epoch seconds over a day) whose day-pass payment is taken care of or under way, once a day. */
    const paying = yield* Ref.make<number | undefined>(undefined)
    const spent = Effect.fn('Budget.spent')(function* (now: number, limit: number) {
      const { day, resetsAt } = utcDay(now)
      const milli = yield* attemptSync(() => ledger.milliCredits(day))
      return { used: milli / 1000, limit, resetsAt }
    })
    // Without a plan the allowance is none. The plan is read through `require`, whose answer the agent keeps a minute.
    const today = Effect.fn('Budget.today')(function* (now: number) {
      const allowance = yield* plans.require().pipe(
        Effect.map((plan) => plan.dailyCredits),
        Effect.catchTag('SubscriptionRequired', () => Effect.succeed(0)),
      )
      return yield* spent(now, allowance)
    })
    const require = Effect.fn('Budget.require')(function* (now: number) {
      const current = yield* spent(now, (yield* plans.require()).dailyCredits)
      if (current.used >= current.limit)
        return yield* new BudgetExhausted({ limit: current.limit, resetsAt: current.resetsAt })
    })
    // Past the Credits a call goes on while the owner's pay mode lets their wallet pay it (ADR 0047): always in `wallet`
    // mode, whose calls never draw on the Credits. The pay mode is read only once they are spent.
    const open = Effect.fn('Budget.open')(function* (now: number) {
      return yield* require(now).pipe(
        Effect.catchTag('BudgetExhausted', (exhausted) =>
          Effect.flatMap(pay.choice, (choice) => (walletPaysWhenSpent(choice) ? Effect.void : Effect.fail(exhausted))),
        ),
      )
    })
    /**
     * A day pass's day (ADR 0054): the first admitted message of a UTC day takes its payment in the background, so the
     * answer never waits for it. Only a payment that may go through later (still landing, or the wallet not reached)
     * is tried again with the next message.
     */
    const payToday = Effect.fn('Budget.payToday')(function* (now: number) {
      const day = Math.floor(now / 86_400)
      const claimed = yield* Ref.modify(paying, (current) => [current !== day, day] as const)
      if (!claimed) return
      yield* plans.payDay().pipe(
        Effect.flatMap((outcome) => (outcome === 'retry' ? Ref.set(paying, undefined) : Effect.void)),
        background('billing.payDay'),
      )
    })
    return Budget.of({
      today,
      record: Effect.fn('Budget.record')(function* (use, now, model?: string) {
        yield* Effect.sync(() => recordUse(ledger, rates, use, now, model))
      }),
      require,
      open,
      admit: Effect.fn('Budget.admit')(function* (now) {
        yield* open(now)
        if ((yield* plans.require()).billing === 'day') yield* payToday(now)
      }),
    })
  }),
)

/** The model picker over the agent's SQLite: the owner's pick among what the deployment offers. */
const ModelsLive: Layer.Layer<Models, never, AgentInput | Db> = Layer.effect(
  Models,
  Effect.gen(function* () {
    const { env } = yield* AgentInput
    const models = new ModelPicker(new ModelChoiceStore(yield* Db), modelOptions(env.MODELS, env.MODEL_ID))
    return Models.of({
      current: sync('Models.current', models.current.bind(models))(),
      choice: sync('Models.choice', models.choice.bind(models))(),
      choose: trySync('Models.choose', models.choose.bind(models)),
    })
  }),
)

/**
 * The daily model budget, over the plan the core layer keeps, how goblin pays for its calls, and the model picker, over
 * the agent's SQLite (they keep no state of their own). A send's admission reads them, so `layers/index.ts` builds them
 * before the conversation layer; the pay mode reads the MCP host, built at the start's step 2.
 */
export const ModelBudgetLive: Layer.Layer<
  Budget | Pay | Models,
  never,
  AgentInput | Db | Entitlements | McpServers | McpGrants
> = Layer.mergeAll(BudgetLive.pipe(Layer.provideMerge(PayLive)), ModelsLive)
