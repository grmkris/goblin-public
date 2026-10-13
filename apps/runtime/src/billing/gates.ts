import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import { SubscriptionRequired } from '../http/errors.ts'
import type { RuntimeEnv } from '../env.ts'
import { reportAndRecover } from '../observability/report.ts'
import { type DayOutcome, payToday } from './day-pass.ts'
import { type Feature, planCatalog } from './plans.ts'
import { planOf, type AccountPlan } from './reconcile.ts'
import { makeBillingStore } from './store.ts'
import { WalletMerchant, configuredMerchant } from './wallet.ts'
import type { Internal } from '../http/errors.ts'

export const billingMode = (env: RuntimeEnv) => (env.STAGE === 'prod' ? 'live_mode' : 'test_mode')
/**
 * The feature gate shared by turn admission, the budget, routines and subagents. The Worker edge reads no plan (ADR
 * 0054, amended 2026-10-13): owner requests reach the agent, which checks it where something needs one.
 */
export interface EntitlementPolicy {
  readonly require: (feature?: Feature) => Effect.Effect<AccountPlan, Internal | SubscriptionRequired>
  readonly state: () => Effect.Effect<AccountPlan, Internal>
  /**
   * An owner's message was admitted on a day pass (ADR 0054): takes the UTC day's payment unless it is paid. Never
   * fails: what it could not do is reported, and the next message tries again.
   */
  readonly payDay: () => Effect.Effect<DayOutcome>
}
export const accountEntitlements = (env: RuntimeEnv, userId: () => string): EntitlementPolicy => {
  const store = makeBillingStore(env.AUTH_DB)
  const catalog = planCatalog(env.PLAN_CATALOG)
  const merchant = configuredMerchant(env)
  const state = () => planOf(store, userId(), env.STAGE ?? 'test', billingMode(env), { catalog })
  return {
    state,
    require: (feature) => activePlan(state(), feature),
    payDay: () =>
      merchant === undefined
        ? Effect.succeed('settled')
        : payToday(store, userId()).pipe(
            Effect.provideService(WalletMerchant, merchant),
            reportAndRecover('billing.payDay', 'retry' as const),
          ),
  }
}
export class Entitlements extends Context.Service<Entitlements, EntitlementPolicy>()('goblin/Entitlements') {
  static layer(env: RuntimeEnv, userId: () => string) {
    return Layer.succeed(Entitlements, accountEntitlements(env, userId))
  }
}

/**
 * The plan the agent keeps, `SubscriptionRequired` unless it is active and, when `feature` is named, includes it.
 */
export const requirePlan = (
  feature?: Feature,
): Effect.Effect<AccountPlan, Internal | SubscriptionRequired, Entitlements> =>
  Entitlements.use((plans) => plans.require(feature))

/** What goblin Pro, the one plan, includes: everything. A plan that left a feature out would say so here. */
const PRO_FEATURES: Readonly<Record<Feature, boolean>> = {
  agent: true,
  routines: true,
  handOver: true,
  subagents: true,
}

/**
 * `plan`, when it is active and includes `feature`; else `SubscriptionRequired`. Without a plan it names `chat`:
 * there is no free plan, so goblin does not answer (ADR 0054, amended 2026-10-13). A feature the plan left out would be
 * named, as a hand-over was on the free plan (ADR 0012, amended 2026-10-12).
 */
const included = (plan: AccountPlan, feature?: Feature) =>
  plan.active && PRO_FEATURES[feature ?? 'agent']
    ? Effect.succeed(plan)
    : Effect.fail(
        new SubscriptionRequired({
          subscribe: '/subscribe',
          feature: plan.active && feature === 'handOver' ? ('hand_over' as const) : ('chat' as const),
        }),
      )

const activePlan = (state: Effect.Effect<AccountPlan, Internal>, feature?: Feature) =>
  Effect.flatMap(state, (plan) => included(plan, feature))

/** How long the agent keeps an active plan before it reads auth D1 again (ADR 0015, 0026). */
const PLAN_TTL = Duration.seconds(60)

/**
 * `policy` as the agent checks it: an active plan is kept for a minute, so each tool call, routine dispatch and owner
 * request stops reading auth D1. A plan that is not active, or a read that failed, is not kept, so a subscription
 * counts at once and a failed read is tried again. `require` and `state` keep the policy's own answers, each in its own
 * cache; a day's payment drops both once it is done, so a day pass that could not pay is refused from the next message
 * on.
 */
export const cachedPolicy = Effect.fn('Entitlements.cachedPolicy')(function* (policy: EntitlementPolicy) {
  const keep = (exit: Exit.Exit<AccountPlan, unknown>) =>
    Exit.isSuccess(exit) && exit.value.active ? PLAN_TTL : Duration.zero
  const [state, forgetState] = yield* Effect.cachedInvalidateWithTTL(policy.state(), keep)
  const [require, forgetRequire] = yield* Effect.cachedInvalidateWithTTL(policy.require(), keep)
  // The cached answer is the plan's; each feature is checked on it.
  return Entitlements.of({
    state: () => state,
    require: (feature) => Effect.flatMap(require, (plan) => included(plan, feature)),
    payDay: () => policy.payDay().pipe(Effect.ensuring(Effect.andThen(forgetState, forgetRequire))),
  })
})

/**
 * The account's plan read fresh from auth D1, as the Worker edge checks it before it resolves an Agent stub:
 * `SubscriptionRequired` unless it is active. Missing provider keys never disable this gate.
 */
export const accountPlan = (env: RuntimeEnv, userId: string) => accountEntitlements(env, () => userId).require()
