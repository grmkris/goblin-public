import { createAgentWallet } from '@goblin/wallet/privy'
import { productionAllowance } from './allowance.ts'
import { defaultWiring, type Wiring } from './context.ts'
import type { WalletEnv } from './env.ts'
import { ledgerClient } from './ledger/client.ts'
import { ownerRailsDeps, ownerSigner, privyFor } from './owner-deps.ts'
import { createRails } from './rails/index.ts'

const ledgerOf = (env: WalletEnv, userId: string) => ledgerClient(env.LEDGER.getByName(userId))

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
  signer: (env, owner) => ownerSigner(env, ledgerOf(env, owner.userId)),
  rails: (env, owner, signer) => createRails(ownerRailsDeps(env, ledgerOf(env, owner.userId), signer)),
}
