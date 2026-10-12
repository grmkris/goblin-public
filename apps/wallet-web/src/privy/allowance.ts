import type { EvmChain } from '@goblin/wallet/balances'
import { type Me, OwnerRoutes, type UsdAmount } from '@goblin/wallet/contract'
import { reviewAllowance } from '@goblin/wallet/delegation'
import { useSignTypedData } from '@privy-io/react-auth'
import { useCallback, useMemo } from 'react'
import { getAddress } from 'viem'
import { FlowFailure, type FlowState, ownerCall, useFlow } from './flow.ts'
import { chainFor } from './network.ts'
import { useOwner } from './owner.ts'
import { allowancePrompt, walletTypedData } from './prompts.ts'

/** What the owner chose: the chain, how much USDC an hour and for how many days. */
export interface AllowanceInput {
  readonly chain: EvmChain
  readonly perHour: UsdAmount
  readonly days: number
}

export interface SignAllowance {
  readonly state: FlowState
  /**
   * `POST /api/allowance/prepare`, rebuilds the delegation locally and compares it with what the server sent, asks
   * the owner to sign the rebuilt one on Privy's screen ("Let your agent spend up to $X an hour…"), then
   * `POST /api/allowance/confirm`. Resolves with the updated `Me`.
   */
  readonly sign: (input: AllowanceInput) => Promise<Me>
  readonly reset: () => void
}

/**
 * The owner's ERC-7710 allowance to the agent on any EVM chain the wallet serves. The owner never signs what the
 * server merely says: every chain's draft is rebuilt for that chain's id, manager and USDC and compared first.
 */
export function useSignAllowance(): SignAllowance {
  const { address, getToken } = useOwner()
  const { signTypedData } = useSignTypedData()
  const { state, run, reset } = useFlow()
  const sign = useCallback(
    (input: AllowanceInput) =>
      run(async (step) => {
        if (address === undefined)
          throw new FlowFailure({ code: 'no_wallet', message: 'Your wallet is still being created. Try again.' })
        const [chain, me] = await Promise.all([chainFor(input.chain), ownerCall(getToken, OwnerRoutes.me)])
        if (me.agent === undefined)
          throw new FlowFailure({ code: 'not_onboarded', message: 'Create the agent wallet first.' })
        const draft = await ownerCall(getToken, OwnerRoutes.allowancePrepare, {
          body: { chain: input.chain, perHour: input.perHour, days: input.days },
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
          body: { chain: input.chain, delegationHash: reviewed.delegationHash, signature },
        })
      }),
    [address, getToken, run, signTypedData],
  )
  return useMemo(() => ({ state, sign, reset }), [state, sign, reset])
}
