import { httpJsonRpc } from '@goblin/wallet/balances'
import { pimlicoUrl } from '@goblin/wallet/bundler'
import { chainByKey } from '@goblin/wallet/chains'
import type { AgentSigner, ChainKey } from '@goblin/wallet/contract'
import { authorizationSigner, PrivyClient } from '@goblin/wallet/privy'
import { agentSigner } from '@goblin/wallet/signer'
import { allowanceRails } from './allowance.ts'
import type { WalletEnv } from './env.ts'
import type { LedgerApi } from './ledger/client.ts'
import type { RailsDeps } from './rails/deps.ts'
import { runFloat } from './rails/float.ts'
import { rpcFromEnv } from './rails/rpc.ts'
import { failure } from './services/errors.ts'

/** The routine signer's authorization key, imported once per isolate. */
const authorizers = new Map<string, ReturnType<typeof authorizationSigner>>()

export const privyFor = async (env: WalletEnv): Promise<PrivyClient> => {
  if (env.PRIVY_APP_SECRET === '' || env.PRIVY_AUTHORIZATION_KEY === '')
    throw failure('not_configured', 'Privy is not configured on this deployment.', 501)
  const cached = authorizers.get(env.PRIVY_AUTHORIZATION_KEY)
  const authorize = cached ?? authorizationSigner(env.PRIVY_AUTHORIZATION_KEY)
  authorizers.set(env.PRIVY_AUTHORIZATION_KEY, authorize)
  return new PrivyClient({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET, authorize: await authorize })
}

/** Pimlico's bundler per chain, or undefined where no key is configured (then no UserOperation is sent). */
const bundlersFor = (env: WalletEnv, live: boolean) =>
  env.PIMLICO_API_KEY === ''
    ? undefined
    : (chain: ChainKey) => httpJsonRpc(pimlicoUrl(chainByKey(chain, live).id, env.PIMLICO_API_KEY))

/** The network, each chain's node and Pimlico's bundler, for a send that is not the agent's (the collector's, ADR 0054). */
export const chainAccess = (env: WalletEnv) => {
  const live = env.WALLET_LIVE === '1'
  return { live, rpcFor: rpcFromEnv(env.RPC_URLS, live), bundlerFor: bundlersFor(env, live) }
}

/** goblin's collector as a signer: the project's server wallet, held by its Privy policy to redeeming and its gas. */
export const collectorSigner = async (
  env: WalletEnv,
  collector: { readonly walletId: string; readonly address: string },
): Promise<AgentSigner> =>
  agentSigner({
    privy: await privyFor(env),
    walletId: collector.walletId,
    address: collector.address,
    live: env.WALLET_LIVE === '1',
  })

/** The owner's agent signer, from the agent wallet their ledger records; undefined before onboarding made it. */
export const ownerSigner = async (env: WalletEnv, ledger: Pick<LedgerApi, 'profile'>) => {
  const profile = await ledger.profile()
  if (profile.agentAddress === undefined || profile.agentWalletId === undefined) return undefined
  return agentSigner({
    privy: await privyFor(env),
    walletId: profile.agentWalletId,
    address: profile.agentAddress,
    live: env.WALLET_LIVE === '1',
  })
}

/**
 * Everything the rails need for one owner, given their ledger: the network, the signer, the nodes and Pimlico, the
 * owner's allowance (how the agent tops itself up and what is left), and the Tempo float's single flight.
 */
export const ownerRailsDeps = (env: WalletEnv, ledger: LedgerApi, signer: AgentSigner | undefined): RailsDeps => {
  const { live, rpcFor, bundlerFor } = chainAccess(env)
  return {
    live,
    signer,
    profile: () => ledger.profile(),
    rpcFor,
    ...allowanceRails(env, ledger, rpcFor),
    ...(bundlerFor === undefined ? {} : { bundlerFor }),
    float: { state: () => ledger.floatState(), schedule: (request) => ledger.scheduleFloat(request) },
  }
}

/** The deployed ledger's float alarm: one refill run with the owner's own signer and rails (ADR 0051). */
export const floatRunnerFor =
  (env: WalletEnv) =>
  async (ledger: LedgerApi): Promise<{ retryInMs?: number }> =>
    runFloat(ownerRailsDeps(env, ledger, await ownerSigner(env, ledger)), ledger)
