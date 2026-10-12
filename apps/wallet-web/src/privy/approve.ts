import { type ApprovalView, OwnerRoutes, termsHash } from '@goblin/wallet/contract'
import { useCallback, useMemo } from 'react'
import { FlowFailure, type FlowState, ownerCall, useFlow } from './flow.ts'
import { useOwner } from './owner.ts'

export interface Approve {
  readonly state: FlowState
  /**
   * Posts the owner's decision on a frozen spend (`POST /api/approvals/:operationId`) after rebuilding `termsHash`
   * from `view.terms`. Signs nothing: approval binds to the terms hash the owner saw.
   */
  readonly decide: (
    view: ApprovalView,
    decision: 'approve' | 'decline',
    options?: { readonly remember?: boolean },
  ) => Promise<ApprovalView>
  readonly reset: () => void
}

/** The Approve page's decision, bound to the terms the page showed. */
export function useApprove(): Approve {
  const { getToken } = useOwner()
  const { state, run, reset } = useFlow()
  const decide = useCallback(
    (view: ApprovalView, decision: 'approve' | 'decline', options: { readonly remember?: boolean } = {}) =>
      run(async (step) => {
        step('checking')
        const hash = await termsHash(view.terms)
        if (hash !== view.termsHash.toLowerCase())
          throw new FlowFailure({
            code: 'terms_mismatch',
            message: 'These terms do not match what the wallet froze. Reload the page before deciding.',
          })
        step('submitting')
        return ownerCall(getToken, OwnerRoutes.decide, {
          params: { operationId: view.operationId },
          body: {
            decision,
            termsHash: hash,
            ...(options.remember === undefined ? {} : { remember: options.remember }),
          },
        })
      }),
    [getToken, run],
  )
  return useMemo(() => ({ state, decide, reset }), [state, decide, reset])
}
