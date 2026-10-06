import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
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
const requirePlan = (state: ReturnType<typeof planOf>) =>
  state.pipe(
    Effect.flatMap((plan) =>
      plan.active ? Effect.succeed(plan) : Effect.fail(new SubscriptionRequired({ subscribe: '/subscribe' })),
    ),
  )

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
