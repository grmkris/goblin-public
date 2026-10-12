import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import { SubscriptionRequired } from '../http/errors.ts'
import type { RuntimeEnv } from '../env.ts'
import { type Feature, freeCredits, freeIncludes } from './plans.ts'
import { planOf, type AccountPlan } from './reconcile.ts'
import { makeBillingStore } from './store.ts'
import type { Internal } from '../http/errors.ts'

export const billingMode = (env: RuntimeEnv) => (env.STAGE === 'prod' ? 'live_mode' : 'test_mode')
/** The feature gate shared by Worker admission, budget, routines and subagents. */
export interface EntitlementPolicy {
  readonly require: (feature?: Feature) => Effect.Effect<AccountPlan, Internal | SubscriptionRequired>
  readonly state: () => Effect.Effect<AccountPlan, Internal>
}
export const accountEntitlements = (env: RuntimeEnv, userId: () => string): EntitlementPolicy => {
  const store = makeBillingStore(env.AUTH_DB)
  const free = freeCredits(env.FREE_DAILY_CREDITS)
  const state = () => planOf(store, userId(), env.STAGE ?? 'test', billingMode(env), { free })
  return { state, require: (feature) => activePlan(state(), feature) }
}
export class Entitlements extends Context.Service<Entitlements, EntitlementPolicy>()('goblin/Entitlements') {
  static layer(env: RuntimeEnv, userId: () => string) {
    return Layer.succeed(Entitlements, accountEntitlements(env, userId))
  }
}

/**
 * The plan the agent keeps, `SubscriptionRequired` unless it is active and, when `feature` is named, includes it: the
 * free plan has routines that tell the owner, but no hand-over.
 */
export const requirePlan = (
  feature?: Feature,
): Effect.Effect<AccountPlan, Internal | SubscriptionRequired, Entitlements> =>
  Entitlements.use((plans) => plans.require(feature))

/**
 * `plan`, when it is active and includes `feature`; else `SubscriptionRequired`, which names a hand-over when that is
 * what the free plan lacks, so the owner reads why (ADR 0012, amended 2026-10-12).
 */
const included = (plan: AccountPlan, feature?: Feature) =>
  plan.active && !(plan.source === 'free' && !freeIncludes(feature))
    ? Effect.succeed(plan)
    : Effect.fail(
        new SubscriptionRequired({
          subscribe: '/subscribe',
          ...(plan.active && feature === 'handOver' ? { feature: 'hand_over' as const } : {}),
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
 * cache. The Worker edge never uses this: it reads the plan fresh.
 */
export const cachedPolicy = Effect.fn('Entitlements.cachedPolicy')(function* (policy: EntitlementPolicy) {
  const keep = (exit: Exit.Exit<AccountPlan, unknown>) =>
    Exit.isSuccess(exit) && exit.value.active ? PLAN_TTL : Duration.zero
  const [state] = yield* Effect.cachedInvalidateWithTTL(policy.state(), keep)
  const [require] = yield* Effect.cachedInvalidateWithTTL(policy.require(), keep)
  // The cached answer is the plan's; each feature is checked on it, so a free plan never passes for a hand-over.
  return Entitlements.of({
    state: () => state,
    require: (feature) => Effect.flatMap(require, (plan) => included(plan, feature)),
  })
})

/**
 * The account's plan read fresh from auth D1, as the Worker edge checks it before it resolves an Agent stub:
 * `SubscriptionRequired` unless it is active. Missing provider keys never disable this gate.
 */
export const accountPlan = (env: RuntimeEnv, userId: string) => accountEntitlements(env, () => userId).require()
