// What the app needs from the signed-in owner: who they are and the two signatures onboarding asks for. The Privy
// implementation lives in src/privy/** (lane S) and is mounted by `main.tsx`; `fixture-auth.tsx` stands in for demos.
import { createContext, use } from 'react'

export interface Auth {
  readonly status: 'loading' | 'signed-out' | 'ready'
  readonly address?: string
  /** A current access token for the API; null when signed out. */
  readonly getToken: () => Promise<string | null>
  readonly login: () => void
  readonly logout: () => void
  /** Sign the owner's EIP-7702 authorization for Base and have the relay send it. */
  readonly upgrade: (chain: 'base') => Promise<void>
  /** Prepare the allowance, rebuild and compare it, sign it, confirm it. */
  readonly signAllowance: (input: {
    readonly chain: 'base'
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
