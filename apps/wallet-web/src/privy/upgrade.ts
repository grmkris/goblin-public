import type { ChainKey } from '@goblin/wallet/chains'
import { type Operation, OwnerRoutes } from '@goblin/wallet/contract'
import { useSign7702Authorization } from '@privy-io/react-auth'
import { useCallback, useMemo } from 'react'
import { getAddress } from 'viem'
import { FlowFailure, type FlowState, ownerCall, useFlow } from './flow.ts'
import { chainFor, pendingNonce } from './network.ts'
import { useOwner } from './owner.ts'

export interface UpgradeAccount {
  readonly state: FlowState
  /**
   * Signs the EIP-7702 authorization that points the owner wallet at the MetaMask DeleGator for its pending nonce on
   * `chain`, and posts it to `POST /api/onboarding/upgrade`; the relay sends it and pays the gas. Resolves with the
   * relay's operation; rejects (and sets `state` to error) when the owner declines or the relay refuses.
   */
  readonly upgrade: () => Promise<Operation>
  readonly reset: () => void
}

/**
 * The 7702 upgrade of the owner wallet on one chain. Privy's embedded wallet signs only the authorization (its own
 * transaction signing drops `authorizationList`), for its current nonce since the relay, not the owner, sends it.
 */
export function useUpgradeAccount(key: ChainKey): UpgradeAccount {
  const { address, getToken } = useOwner()
  const { signAuthorization } = useSign7702Authorization()
  const { state, run, reset } = useFlow()
  const upgrade = useCallback(
    () =>
      run(async (step) => {
        if (address === undefined)
          throw new FlowFailure({ code: 'no_wallet', message: 'Your wallet is still being created. Try again.' })
        const chain = await chainFor(key)
        const delegator = chain.delegation.delegator
        const owner = getAddress(address)
        const nonce = await pendingNonce(chain, owner)
        step('signing')
        const signed = await signAuthorization(
          { contractAddress: delegator, chainId: chain.id, nonce },
          { address: owner },
        )
        step('submitting')
        return ownerCall(getToken, OwnerRoutes.upgrade, {
          body: {
            chain: key,
            authorization: {
              address: delegator,
              chainId: signed.chainId,
              nonce: signed.nonce,
              r: signed.r,
              s: signed.s,
              yParity: signed.yParity,
            },
          },
        })
      }),
    [address, getToken, key, run, signAuthorization],
  )
  return useMemo(() => ({ state, upgrade, reset }), [state, upgrade, reset])
}
