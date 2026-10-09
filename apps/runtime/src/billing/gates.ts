import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import { SubscriptionRequired } from '../http/errors.ts'
import type { RuntimeEnv } from '../env.ts'
import { planOf, type AccountPlan } from './reconcile.ts'
import { makeBillingStore } from './store.ts'
import type { Internal } from '../http/errors.ts'

export const billingMode = (env: RuntimeEnv) => (env.STAGE === 'prod' ? 'live_mode' : 'test_mode')
/** The feature gate shared by Worker admission, budget, routines and subagents. */
export interface EntitlementPolicy {
  readonly require: (
    feature?: 'agent' | 'routines' | 'subagents',
  ) => Effect.Effect<AccountPlan, Internal | SubscriptionRequired>
  readonly state: () => Effect.Effect<AccountPlan, Internal>
}
export const accountEntitlements = (env: RuntimeEnv, userId: () => string): EntitlementPolicy => {
  const store = makeBillingStore(env.AUTH_DB)
  const state = () => planOf(store, userId(), env.STAGE ?? 'test', billingMode(env))
  return { state, require: () => requirePlan(state()) }
}
export class Entitlements extends Context.Service<Entitlements, EntitlementPolicy>()('goblin/Entitlements') {
  static layer(env: RuntimeEnv, userId: () => string) {
    return Layer.succeed(Entitlements, accountEntitlements(env, userId))
  }
}
const requirePlan = <E>(state: Effect.Effect<AccountPlan, E>) =>
  state.pipe(
    Effect.flatMap((plan) =>
      plan.active ? Effect.succeed(plan) : Effect.fail(new SubscriptionRequired({ subscribe: '/subscribe' })),
    ),
  )

/** How long the agent keeps an active plan before it reads auth D1 again (ADR 0015, 0026). */
const PLAN_TTL = Duration.seconds(60)

/**
 * `policy` as the agent checks it: an active plan is kept for a minute, so each tool call, routine dispatch and owner
 * request stops reading auth D1. A plan that is not active, or a read that failed, is not kept, so a subscription
 * counts at once and a failed read is tried again. The Worker edge never uses this: it reads the plan fresh.
 */
export const cachedPolicy = Effect.fn('Entitlements.cachedPolicy')(function* (policy: EntitlementPolicy) {
  const [state] = yield* Effect.cachedInvalidateWithTTL(policy.state(), (exit) =>
    Exit.isSuccess(exit) && exit.value.active ? PLAN_TTL : Duration.zero,
  )
  return Entitlements.of({ state: () => state, require: () => requirePlan(state) })
})

/** Before resolving an Agent stub. Missing provider keys never disable this gate. */
export async function requireAccountPlan(env: RuntimeEnv, userId: string) {
  const plan = await Effect.runPromise(
    Entitlements.use((entitlements) => entitlements.state()).pipe(
      Effect.provide(Entitlements.layer(env, () => userId)),
    ),
  )
  if (!plan.active) throw new SubscriptionRequired({ subscribe: '/subscribe' })
  return plan
}
