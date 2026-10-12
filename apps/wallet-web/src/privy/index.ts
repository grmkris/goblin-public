/**
 * Owner sign-in and owner signing in the browser, through Privy (whatever sign-in the dashboard enables, an EVM
 * embedded wallet created at the first sign-in). Every hook acts for the signed-in owner only, and none of them ever
 * sees a server key.
 */
export { PrivyRoot } from './root.tsx'
export { useOwner } from './owner.ts'
export { useUpgradeAccount } from './upgrade.ts'
export { useSignAllowance } from './allowance.ts'
