import type { ChainKey } from '@goblin/wallet/chains'
import { type Me, OwnerRoutes, type UsdAmount } from '@goblin/wallet/contract'
import { reviewAllowance } from '@goblin/wallet/delegation'
import { useSignTypedData } from '@privy-io/react-auth'
import { useCallback, useMemo } from 'react'
import { getAddress } from 'viem'
import { FlowFailure, type FlowState, ownerCall, useFlow } from './flow.ts'
import { chainFor } from './network.ts'
import { useOwner } from './owner.ts'
import { allowancePrompt, walletTypedData } from './prompts.ts'

export interface SignAllowance {
  readonly state: FlowState
  /**
   * `POST /api/allowance/prepare`, rebuilds the delegation locally and compares it with what the server sent, asks
   * the owner to sign the rebuilt one on Privy's screen ("Let your agent spend up to $X an hour…"), then
   * `POST /api/allowance/confirm`. Resolves with the updated `Me`.
   */
  readonly sign: (input: { readonly perHour: UsdAmount; readonly days: number }) => Promise<Me>
  readonly reset: () => void
}

/** The owner's ERC-7710 allowance to the agent on one chain. The owner never signs what the server merely says. */
export function useSignAllowance(key: ChainKey): SignAllowance {
  const { address, getToken } = useOwner()
  const { signTypedData } = useSignTypedData()
  const { state, run, reset } = useFlow()
  const sign = useCallback(
    (input: { readonly perHour: UsdAmount; readonly days: number }) =>
      run(async (step) => {
        if (address === undefined)
          throw new FlowFailure({ code: 'no_wallet', message: 'Your wallet is still being created. Try again.' })
        const [chain, me] = await Promise.all([chainFor(key), ownerCall(getToken, OwnerRoutes.me)])
        if (me.agent === undefined)
          throw new FlowFailure({ code: 'not_onboarded', message: 'Create the agent wallet first.' })
        const draft = await ownerCall(getToken, OwnerRoutes.allowancePrepare, {
          body: { chain: key, perHour: input.perHour, days: input.days },
        })
        step('checking')
        const choice = {
          chain,
          owner: getAddress(address),
          agent: getAddress(me.agent),
          perHour: input.perHour,
          days: input.days,
        }
        const reviewed = reviewAllowance(draft, choice, Date.now())
        step('signing')
        const { signature } = await signTypedData(walletTypedData(reviewed.typedData), {
          address,
          uiOptions: allowancePrompt(chain.name, reviewed.description),
        })
        step('confirming')
        return ownerCall(getToken, OwnerRoutes.allowanceConfirm, {
          body: { chain: key, delegationHash: reviewed.delegationHash, signature },
        })
      }),
    [address, getToken, key, run, signTypedData],
  )
  return useMemo(() => ({ state, sign, reset }), [state, sign, reset])
}
