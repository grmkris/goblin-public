import { memoryRelayStore, RelaySender, relayAccountFromKey } from '@goblin/wallet/relay'
import { agentSigner } from '@goblin/wallet/signer'
import { authorizationSigner, createAgentWallet, PrivyClient } from '@goblin/wallet/privy'
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

/** One relay sender per isolate and key: it serializes its nonce, and its store lives as long as the isolate. */
const relays = new Map<string, RelaySender>()

const relayFor = (env: WalletEnv, rpcFor: ReturnType<typeof rpcFromEnv>): RelaySender | undefined => {
  if (env.RELAY_PRIVATE_KEY === '') return undefined
  const cached = relays.get(env.RELAY_PRIVATE_KEY)
  if (cached !== undefined) return cached
  const relay = new RelaySender({
    account: relayAccountFromKey(env.RELAY_PRIVATE_KEY),
    store: memoryRelayStore(),
    rpc: rpcFor,
  })
  relays.set(env.RELAY_PRIVATE_KEY, relay)
  return relay
}

/**
 * The deployed wiring: Privy for the agent wallet and its signer. The payment rails (lane D) are wired; the allowance
 * builders join as lane S's adapters land, and until then the rails top up nothing and report no on-chain limits.
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
  rails: (env, owner, signer) => {
    const rpcFor = rpcFromEnv(env.RPC_URLS)
    const relay = relayFor(env, rpcFor)
    return createRails({
      signer,
      profile: () => ledgerClient(env.LEDGER.getByName(owner.userId)).profile(),
      rpcFor,
      ...(relay === undefined ? {} : { relay }),
    })
  },
}
