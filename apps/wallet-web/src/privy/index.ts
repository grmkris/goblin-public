/**
 * Owner sign-in and owner signing in the browser, through Privy (email or Google, an EVM embedded wallet created at
 * login). Sign-in and the owner are live; the signing flows below are still stubs. Every hook acts for
 * the signed-in owner only, and none of them ever sees a server key.
 */
import type { ApprovalView, ChainKey, Me, Operation, UsdAmount } from '@goblin/wallet/contract'

export { PrivyRoot } from './root.tsx'
export { ownerAddress, useOwner, type Owner } from './owner.ts'

/** The step a signing flow is on, for a progress line. */
export type FlowStep = 'preparing' | 'checking' | 'signing' | 'submitting' | 'confirming'

/**
 * Where one signing flow stands. `code` is stable (e.g. `rejected` when the owner closed Privy's screen,
 * `terms_mismatch` when what the server asked to sign is not what the owner chose); `message` is for people.
 */
export type FlowState =
  | { readonly status: 'idle' }
  | { readonly status: 'working'; readonly step: FlowStep }
  | { readonly status: 'done' }
  | { readonly status: 'error'; readonly code: string; readonly message: string }

export interface UpgradeAccount {
  readonly state: FlowState
  /**
   * Signs the EIP-7702 authorization that points the owner wallet at the MetaMask DeleGator for its pending nonce on
   * `chain`, and posts it to `POST /api/onboarding/upgrade`; the relay sends it and pays the gas. Resolves with the
   * relay's operation; rejects (and sets `state` to error) when the owner declines or the relay refuses.
   */
  upgrade(): Promise<Operation>
  reset(): void
}

export interface SignAllowance {
  readonly state: FlowState
  /**
   * `POST /api/allowance/prepare`, rebuilds the delegation locally and compares it with what the server sent, asks
   * the owner to sign it on Privy's screen ("Let your agent spend up to $X an hour…"), then
   * `POST /api/allowance/confirm`. Resolves with the updated `Me`.
   */
  sign(input: { readonly perHour: UsdAmount; readonly days: number }): Promise<Me>
  reset(): void
}

export interface Approve {
  readonly state: FlowState
  /**
   * Posts the owner's decision on a frozen spend (`POST /api/approvals/:operationId`) after rebuilding `termsHash`
   * from `view.terms`. Signs nothing: approval binds to the terms hash the owner saw.
   */
  decide(
    view: ApprovalView,
    decision: 'approve' | 'decline',
    options?: { readonly remember?: boolean },
  ): Promise<ApprovalView>
  reset(): void
}

const notReady = (): Promise<never> => Promise.reject(new Error('not_ready: owner signing is not wired yet'))

/** The 7702 upgrade of the owner wallet on one chain. */
export function useUpgradeAccount(_chain: ChainKey): UpgradeAccount {
  return { state: { status: 'idle' }, upgrade: notReady, reset: () => undefined }
}

/** The owner's ERC-7710 allowance to the agent on one chain. */
export function useSignAllowance(_chain: ChainKey): SignAllowance {
  return { state: { status: 'idle' }, sign: notReady, reset: () => undefined }
}

/** The Approve page's decision. */
export function useApprove(): Approve {
  return { state: { status: 'idle' }, decide: notReady, reset: () => undefined }
}
