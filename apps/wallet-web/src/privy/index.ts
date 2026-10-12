/**
 * Owner sign-in and owner signing in the browser, through Privy (whatever sign-in the dashboard enables, an EVM
 * embedded wallet created at the first sign-in). Every hook acts for the signed-in owner only, and none of them ever
 * sees a server key.
 */
export { PrivyRoot } from './root.tsx'
export { ownerAddress, useOwner, type Owner } from './owner.ts'
export { FlowFailure, type FlowState, type FlowStep } from './flow.ts'
export { useUpgradeAccount, type UpgradeAccount } from './upgrade.ts'
export { useSignAllowance, type SignAllowance } from './allowance.ts'
export { useApprove, type Approve } from './approve.ts'
export { allowancePrompt, walletTypedData, type WalletPrompt } from './prompts.ts'
