import { SubscriptionRoutes, type SubscriptionView } from '@goblin/wallet/contract'
import { revokeCall, reviewSubscription } from '@goblin/wallet/delegation'
import { reviewOwnerCalls, UPGRADE_FEE_CEILINGS } from '@goblin/wallet/userop'
import { useSignTypedData } from '@privy-io/react-auth'
import { useCallback, useMemo } from 'react'
import { getAddress } from 'viem'
import { FlowFailure, type FlowState, ownerCall, useFlow } from './flow.ts'
import { chainFor } from './network.ts'
import { useOwner } from './owner.ts'
import { cancelPrompt, subscriptionPrompt, walletTypedData } from './prompts.ts'

export interface SubscriptionSigning {
  readonly state: FlowState
  /**
   * Signs a merchant's subscription request (ADR 0054): `POST …/prepare`, rebuilds the delegation from the terms the
   * page showed (the owner's address, the collector, the billing, the amount, the period, the months) and compares hashes,
   * asks the owner to sign the rebuilt one on Privy's screen, then `POST …/confirm`. Resolves with the subscription.
   */
  readonly sign: (view: SubscriptionView) => Promise<SubscriptionView>
  /**
   * Cancels it: `POST …/revoke/prepare` answers a UserOperation from the owner's account; the page rebuilds
   * `disableDelegation` of the signed subscription and checks the operation does that and only pays its gas, the owner
   * signs it, then `POST …/revoke` sends it. Resolves `revoked` once the chain shows it, `submitted` while in flight.
   */
  readonly cancel: (view: SubscriptionView) => Promise<'revoked' | 'submitted'>
}

const noWallet = () => new FlowFailure({ code: 'no_wallet', message: 'Your wallet is still being created. Try again.' })

/** Subscribing and cancelling, as the owner's own signatures; the owner never signs what the wallet merely says. */
export function useSubscriptionSigning(): SubscriptionSigning {
  const { address, getToken } = useOwner()
  const { signTypedData } = useSignTypedData()
  const { state, run } = useFlow()
  const sign = useCallback(
    (view: SubscriptionView) =>
      run(async (step) => {
        if (address === undefined) throw noWallet()
        const chain = await chainFor(view.chain)
        const draft = await ownerCall(getToken, SubscriptionRoutes.prepare, { params: { id: view.id } })
        step('checking')
        const reviewed = reviewSubscription(
          draft,
          {
            chain,
            owner: getAddress(address),
            collector: getAddress(view.collector),
            terms: {
              billing: view.billing,
              amountUsd: view.amountUsd,
              periodDays: view.periodDays,
              months: view.months,
            },
          },
          Date.now(),
        )
        step('signing')
        const { signature } = await signTypedData(walletTypedData(reviewed.typedData), {
          address,
          uiOptions: subscriptionPrompt(chain.name, view.merchant, reviewed.description),
        })
        step('confirming')
        return ownerCall(getToken, SubscriptionRoutes.confirm, {
          params: { id: view.id },
          body: { delegationHash: reviewed.delegationHash, signature },
        })
      }),
    [address, getToken, run, signTypedData],
  )
  const cancel = useCallback(
    (view: SubscriptionView) =>
      run(async (step) => {
        if (address === undefined) throw noWallet()
        if (view.delegation === undefined)
          throw new FlowFailure({ code: 'not_active', message: 'This subscription is not active.' })
        const chain = await chainFor(view.chain)
        const draft = await ownerCall(getToken, SubscriptionRoutes.revokePrepare, { params: { id: view.id } })
        step('checking')
        const reviewed = reviewOwnerCalls(
          draft.typedData,
          { chain, owner: getAddress(address), feeCeiling: UPGRADE_FEE_CEILINGS.base },
          [revokeCall(chain, view.delegation)],
        )
        step('signing')
        const { signature } = await signTypedData(walletTypedData(reviewed.typedData), {
          address,
          uiOptions: cancelPrompt(view.merchant, reviewed.maxFee),
        })
        step('submitting')
        const result = await ownerCall(getToken, SubscriptionRoutes.revoke, {
          params: { id: view.id },
          body: { revokeId: draft.revokeId, signature },
        })
        return result.status
      }),
    [address, getToken, run, signTypedData],
  )
  return useMemo(() => ({ state, sign, cancel }), [state, sign, cancel])
}
