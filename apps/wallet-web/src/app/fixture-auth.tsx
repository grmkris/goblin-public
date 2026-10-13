import type { SubscriptionView } from '@goblin/wallet/contract'
import { type ReactNode, useMemo, useState } from 'react'
import { OWNER } from '../api/fixtures.ts'
import { type Auth, AuthContext, type OwnerChain } from './auth.tsx'

const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 600))

/**
 * Signed in as the demo owner (or signed out, for the landing at `/`); signing waits a moment and succeeds. Sign out
 * then in again to try the sign-in page.
 */
export function FixtureAuthProvider({
  signedOut = false,
  onUpgrade,
  onAllowance,
  onSubscription,
  children,
}: {
  readonly signedOut?: boolean
  readonly onUpgrade: (chain: OwnerChain) => void
  readonly onAllowance: (input: { readonly chain: OwnerChain; readonly perHour: string }) => void
  readonly onSubscription: (id: string, change: 'signed' | 'cancelled') => SubscriptionView | undefined
  readonly children: ReactNode
}) {
  const [signedIn, setSignedIn] = useState(!signedOut)
  const auth = useMemo<Auth>(
    () => ({
      status: signedIn ? 'ready' : 'signed-out',
      ...(signedIn ? { address: OWNER } : {}),
      getToken: () => Promise.resolve('fixture'),
      login: () => setSignedIn(true),
      logout: () => setSignedIn(false),
      upgrade: async (chain, onStep) => {
        onStep?.('authorize')
        await pause()
        onStep?.('confirm')
        await pause()
        onUpgrade(chain)
        return 'confirmed'
      },
      signAllowance: async ({ chain, perHour }) => {
        await pause()
        onAllowance({ chain, perHour })
      },
      signSubscription: async (view) => {
        await pause()
        return onSubscription(view.id, 'signed') ?? view
      },
      cancelSubscription: async (view) => {
        await pause()
        onSubscription(view.id, 'cancelled')
        return 'revoked'
      },
    }),
    [signedIn, onUpgrade, onAllowance, onSubscription],
  )
  return <AuthContext value={auth}>{children}</AuthContext>
}
