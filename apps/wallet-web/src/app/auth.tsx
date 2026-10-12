// What the app needs from the signed-in owner: who they are and the two signatures each chain asks for. The Privy
// implementation lives in src/privy/** (lane S) and is mounted by `main.tsx`; `fixture-auth.tsx` stands in for demos.
import type { EvmChain } from '@goblin/wallet/balances'
import { createContext, use } from 'react'

/** The chains the owner upgrades and grants an allowance on: every EVM chain the wallet serves (Tempo has no 7702). */
export type OwnerChain = EvmChain

/**
 * Where an upgrade stands once the Worker sent it: `confirmed` when the chain shows the account delegating to the
 * DeleGator, `submitted` while its UserOperation is still in flight. A refusal rejects instead.
 */
export type UpgradeOutcome = 'confirmed' | 'submitted'

export interface Auth {
  readonly status: 'loading' | 'signed-out' | 'ready'
  readonly address?: string
  /** A current access token for the API; null when signed out. */
  readonly getToken: () => Promise<string | null>
  readonly login: () => void
  readonly logout: () => void
  /**
   * Sign the owner's EIP-7702 authorization for `chain`, then the UserOperation that carries it (its gas paid in USDC
   * from the owner's account), and have the Worker send it.
   */
  readonly upgrade: (chain: OwnerChain) => Promise<UpgradeOutcome>
  /** Prepare the allowance on `chain`, rebuild and compare it, sign it, confirm it. */
  readonly signAllowance: (input: {
    readonly chain: OwnerChain
    readonly perHour: string
    readonly days: number
  }) => Promise<void>
}

export const AuthContext = createContext<Auth | undefined>(undefined)

export function useAuth(): Auth {
  const auth = use(AuthContext)
  if (auth === undefined) throw new Error('auth_provider_missing')
  return auth
}
