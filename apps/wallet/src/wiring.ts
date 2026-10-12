import { httpJsonRpc } from '@goblin/wallet/balances'
import { pimlicoUrl } from '@goblin/wallet/bundler'
import { chainByKey } from '@goblin/wallet/chains'
import type { ChainKey } from '@goblin/wallet/contract'
import { agentSigner } from '@goblin/wallet/signer'
import { authorizationSigner, createAgentWallet, PrivyClient } from '@goblin/wallet/privy'
import { allowanceRails, productionAllowance } from './allowance.ts'
import { defaultWiring, type Wiring } from './context.ts'
import type { WalletEnv } from './env.ts'
import { ledgerClient } from './ledger/durable.ts'
import { createRails } from './rails/index.ts'
import { rpcFromEnv } from './rails/rpc.ts'
import { failure } from './services/errors.ts'

/** The routine signer's authorization key, imported once per isolate. */
const authorizers = new Map<string, ReturnType<typeof authorizationSigner>>()

const privyFor = async (env: WalletEnv): Promise<PrivyClient> => {
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

/**
 * The deployed wiring: Privy for the agent wallet and its signer, the owner's on-chain allowance (prepared, confirmed and
 * stored in the ledger), and the payment rails, which top the agent up from that allowance and report what it has left.
 */
export const productionWiring: Wiring = {
  ...defaultWiring,
  allowance: productionAllowance,
  createAgent: async (env, owner) => {
    const wallet = await createAgentWallet(await privyFor(env), {
      userId: owner.userId,
      signerId: env.PRIVY_SIGNER_ID,
      policyId: env.PRIVY_POLICY_ID,
    })
    return { address: wallet.address, walletId: wallet.id }
  },
  signer: async (env, owner) => {
    const profile = await ledgerClient(env.LEDGER.getByName(owner.userId)).profile()
    if (profile.agentAddress === undefined || profile.agentWalletId === undefined) return undefined
    return agentSigner({
      privy: await privyFor(env),
      walletId: profile.agentWalletId,
      address: profile.agentAddress,
      live: env.WALLET_LIVE === '1',
    })
  },
  rails: (env, owner, signer) => {
    const live = env.WALLET_LIVE === '1'
    const rpcFor = rpcFromEnv(env.RPC_URLS, live)
    const bundlerFor = bundlersFor(env, live)
    return createRails({
      live,
      signer,
      profile: () => ledgerClient(env.LEDGER.getByName(owner.userId)).profile(),
      rpcFor,
      ...allowanceRails(env, owner.userId, rpcFor),
      ...(bundlerFor === undefined ? {} : { bundlerFor }),
    })
  },
}
