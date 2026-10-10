import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Entitlements } from '../billing/gates.ts'
import { Budget, UsageStore, recordUse, utcDay } from '../budget.ts'
import { creditRates } from '../budget-credits.ts'
import { BudgetExhausted, attemptSync } from '../http/errors.ts'
import { ModelChoiceStore, ModelPicker, Models, modelOptions } from '../models.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'

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
 * The daily model budget in Credits (ADR 0026) over the agent's usage ledger. The allowance is the plan's, read from
 * the plan the agent keeps (`Entitlements`), so a tool call no longer reads auth D1 each time.
 */
const BudgetLive: Layer.Layer<Budget, never, AgentInput | Db | Entitlements> = Layer.effect(
  Budget,
  Effect.gen(function* () {
    const ledger = new UsageStore(yield* Db)
    const plans = yield* Entitlements
    const { env } = yield* AgentInput
    const rates = creditRates(env.MODEL_CREDIT_RATES)
    const today = Effect.fn('Budget.today')(function* (now: number) {
      const { day, resetsAt } = utcDay(now)
      const { dailyCredits } = yield* plans.require()
      const milli = yield* attemptSync(() => ledger.milliCredits(day))
      return { used: milli / 1000, limit: dailyCredits, resetsAt }
    })
    return Budget.of({
      today,
      record: Effect.fn('Budget.record')(function* (use, now, model?: string) {
        yield* Effect.sync(() => recordUse(ledger, rates, use, now, model))
      }),
      require: Effect.fn('Budget.require')(function* (now) {
        const current = yield* today(now)
        if (current.used >= current.limit)
          return yield* new BudgetExhausted({ limit: current.limit, resetsAt: current.resetsAt })
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
 * The daily model budget, over the plan the core layer keeps, and the model picker, over the agent's SQLite (they keep
 * no state of their own). A send's admission reads them, so `layers/index.ts` builds them before the conversation layer.
 */
export const ModelBudgetLive: Layer.Layer<Budget | Models, never, AgentInput | Db | Entitlements> = Layer.mergeAll(
  BudgetLive,
  ModelsLive,
)
