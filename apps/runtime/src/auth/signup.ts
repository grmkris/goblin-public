import { constantTimeEqual } from 'better-auth/crypto'

export const canonicalEmail = (email: string): string => email.trim().toLowerCase()

export type SignupMode = 'open' | 'invite' | 'closed'
export const signupMode = (value: string | undefined): SignupMode =>
  value === 'open' || value === 'invite' ? value : 'closed'

/** Open lets anyone register; invite needs the configured code; closed (the default) refuses every sign-up. */
export const signupAllowed = (mode: SignupMode, inviteCode: string, presented: string): boolean =>
  mode === 'open' || (mode === 'invite' && inviteCode.length > 0 && constantTimeEqual(presented, inviteCode))
