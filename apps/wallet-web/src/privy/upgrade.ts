import type { EvmChain } from '@goblin/wallet/balances'
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
   * relay's operation, `confirmed` or still `submitted`; rejects (and sets `state` to error) when the owner declines or
   * the relay refuses, with the relay's own reason.
   */
  readonly upgrade: (chain: EvmChain) => Promise<Operation>
  readonly reset: () => void
}

/**
 * The 7702 upgrade of the owner wallet on any EVM chain the wallet serves. Privy's embedded wallet signs only the
 * authorization (its own transaction signing drops `authorizationList`), for its current nonce since the relay, not
 * the owner, sends it. The chain id and the nonce both come from the chain this deployment runs on for `chain`.
 */
export function useUpgradeAccount(): UpgradeAccount {
  const { address, getToken } = useOwner()
  const { signAuthorization } = useSign7702Authorization()
  const { state, run, reset } = useFlow()
  const upgrade = useCallback(
    (key: EvmChain) =>
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
        const operation = await ownerCall(getToken, OwnerRoutes.upgrade, {
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
        // The relay's refusals arrive as a `failed` operation with a 200, so the owner API can record them.
        if (operation.status === 'failed')
          throw new FlowFailure({
            code: 'upgrade_failed',
            message: operation.reason ?? `The relay could not upgrade your account on ${chain.name}.`,
          })
        return operation
      }),
    [address, getToken, run, signAuthorization],
  )
  return useMemo(() => ({ state, upgrade, reset }), [state, upgrade, reset])
}
