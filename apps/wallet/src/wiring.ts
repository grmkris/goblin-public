import { agentSigner } from '@goblin/wallet/signer'
import { authorizationSigner, createAgentWallet, PrivyClient } from '@goblin/wallet/privy'
import { defaultWiring, type Wiring } from './context.ts'
import type { WalletEnv } from './env.ts'
import { ledgerClient } from './ledger/durable.ts'
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

/**
 * The deployed wiring: Privy for the agent wallet and its signer. The payment rails and the allowance builders join
 * here as lane D's and lane S's adapters land; until then they refuse, truthfully, with `not_configured`.
 */
export const productionWiring: Wiring = {
  ...defaultWiring,
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
}
