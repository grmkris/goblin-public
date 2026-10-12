import type { EvmChain } from '@goblin/wallet/balances'
import type { Chain } from '@goblin/wallet/chains'
import { type Operation, OwnerRoutes } from '@goblin/wallet/contract'
import { reviewOwnerUpgrade, UPGRADE_FEE_CEILINGS } from '@goblin/wallet/userop'
import { useSign7702Authorization, useSignTypedData } from '@privy-io/react-auth'
import { useCallback, useMemo } from 'react'
import { type Address, getAddress } from 'viem'
import { FlowFailure, type FlowState, ownerCall, useFlow } from './flow.ts'
import { chainFor, pendingNonce } from './network.ts'
import { useOwner } from './owner.ts'
import { upgradePrompt, walletTypedData } from './prompts.ts'

/** The upgrade's two signatures: the EIP-7702 authorization, then the UserOperation that carries it. */
export type UpgradeStep = 'authorize' | 'confirm'

export interface UpgradeAccount {
  readonly state: FlowState
  /**
   * The owner's one-time account upgrade on `chain`, in two signatures. The first is the EIP-7702 authorization that
   * points the owner's address at the MetaMask DeleGator, for its pending nonce, posted to
   * `POST /api/onboarding/upgrade/prepare`. The Worker answers the UserOperation that carries it, from the owner's own
   * address with its gas paid in their USDC; it is reviewed here and signed second, on Privy's screen ("Upgrade your
   * account"), then `POST /api/onboarding/upgrade` sends it. Resolves with the operation, `confirmed` or still
   * `submitted` (confirmed at once when the account already delegates); rejects, setting `state` to error, when the
   * owner declines, the review finds something else to sign or the Worker refuses, with its reason. `onStep` hears
   * which of the two signatures is being asked for, for a progress list.
   */
  readonly upgrade: (chain: EvmChain, onStep?: (step: UpgradeStep) => void) => Promise<Operation>
  readonly reset: () => void
}

type SignAuthorization = ReturnType<typeof useSign7702Authorization>['signAuthorization']

/**
 * The owner's authorization of the DeleGator on `chain`, as the prepare route takes it. Privy's embedded wallet signs
 * only the authorization (its own transaction signing drops `authorizationList`); it names the account's current
 * nonce because the bundler, not the owner, sends it.
 */
const authorize = async (sign: SignAuthorization, chain: Chain, owner: Address) => {
  const delegator = chain.delegation.delegator
  const nonce = await pendingNonce(chain, owner)
  const signed = await sign({ contractAddress: delegator, chainId: chain.id, nonce }, { address: owner })
  return {
    address: delegator,
    chainId: signed.chainId,
    nonce: signed.nonce,
    r: signed.r,
    s: signed.s,
    yParity: signed.yParity,
  }
}

/**
 * The 7702 upgrade of the owner wallet on any EVM chain the wallet serves, as the owner's own UserOperation. The owner
 * never signs what the server merely says: the operation must be their account's on this chain, through its
 * EntryPoint and paymaster, and do nothing but approve that paymaster for at most the chain's gas ceiling in USDC.
 */
export function useUpgradeAccount(): UpgradeAccount {
  const { address, getToken } = useOwner()
  const { signAuthorization } = useSign7702Authorization()
  const { signTypedData } = useSignTypedData()
  const { state, run, reset } = useFlow()
  const upgrade = useCallback(
    (key: EvmChain, onStep?: (step: UpgradeStep) => void) =>
      run(async (step) => {
        if (address === undefined)
          throw new FlowFailure({ code: 'no_wallet', message: 'Your wallet is still being created. Try again.' })
        const chain = await chainFor(key)
        const owner = getAddress(address)
        step('signing')
        onStep?.('authorize')
        const authorization = await authorize(signAuthorization, chain, owner)
        step('preparing')
        const draft = await ownerCall(getToken, OwnerRoutes.upgradePrepare, { body: { chain: key, authorization } })
        // Already delegating to the DeleGator (a re-run of onboarding): confirmed, nothing more to sign.
        if ('operation' in draft) return draft.operation
        step('checking')
        const reviewed = reviewOwnerUpgrade(draft.typedData, { chain, owner, feeCeiling: UPGRADE_FEE_CEILINGS[key] })
        step('signing')
        onStep?.('confirm')
        const { signature } = await signTypedData(walletTypedData(reviewed.typedData), {
          address,
          uiOptions: upgradePrompt(reviewed.maxFee),
        })
        step('submitting')
        const operation = await ownerCall(getToken, OwnerRoutes.upgrade, {
          body: { chain: key, upgradeId: draft.upgradeId, signature },
        })
        // The bundler's refusals arrive as a `failed` operation with a 200, so the owner API can report them.
        if (operation.status === 'failed')
          throw new FlowFailure({
            code: 'upgrade_failed',
            message: operation.reason ?? `Your account could not be upgraded on ${chain.name}.`,
          })
        return operation
      }),
    [address, getToken, run, signAuthorization, signTypedData],
  )
  return useMemo(() => ({ state, upgrade, reset }), [state, upgrade, reset])
}
