import { type ReactNode, useMemo, useState } from 'react'
import { OWNER } from '../api/fixtures.ts'
import { type Auth, AuthContext } from './auth.tsx'

const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 600))

/** Signed in as the demo owner; signing waits a moment and succeeds. Sign out then in again to try the sign-in page. */
export function FixtureAuthProvider({
  onUpgrade,
  onAllowance,
  children,
}: {
  readonly onUpgrade: () => void
  readonly onAllowance: () => void
  readonly children: ReactNode
}) {
  const [signedIn, setSignedIn] = useState(true)
  const auth = useMemo<Auth>(
    () => ({
      status: signedIn ? 'ready' : 'signed-out',
      ...(signedIn ? { address: OWNER } : {}),
      login: () => setSignedIn(true),
      logout: () => setSignedIn(false),
      upgrade: async () => {
        await pause()
        onUpgrade()
      },
      signAllowance: async () => {
        await pause()
        onAllowance()
      },
    }),
    [signedIn, onUpgrade, onAllowance],
  )
  return <AuthContext value={auth}>{children}</AuthContext>
}
