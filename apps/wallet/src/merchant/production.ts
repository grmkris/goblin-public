import type { WalletEnv } from '../env.ts'
import { subscriptionStore } from '../oauth/durable.ts'
import { chainAccess, collectorSigner } from '../owner-deps.ts'
import type { CollectDeps } from './collect.ts'
import type { MerchantConfig } from './config.ts'
import type { MerchantDeps } from './routes.ts'

/**
 * The collector on this deployment: Base's node and Pimlico, and goblin's collector wallet through Privy. A collector
 * that cannot be reached (Privy not configured, no collector yet) is none: a collection then fails as `chain`, and
 * nothing is sent.
 */
const productionCollector = async (env: WalletEnv, config: MerchantConfig): Promise<CollectDeps> => {
  const access = chainAccess(env)
  const collector =
    config.collector === undefined
      ? undefined
      : await collectorSigner(env, config.collector).catch(
          // expected: Privy not configured on this deployment answers as no collector; nothing is signed.
          () => undefined,
        )
  return {
    live: access.live,
    rpc: access.rpcFor('base'),
    bundler: access.bundlerFor?.('base'),
    collector,
    now: Date.now,
  }
}

/** The deployed merchant API's dependencies: the singleton's subscription store and the collector. */
export const productionMerchant: MerchantDeps = {
  store: (env) => subscriptionStore(env.AUTH),
  collector: productionCollector,
}
