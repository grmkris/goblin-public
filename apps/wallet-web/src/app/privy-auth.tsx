// The real Auth: lane S's Privy hooks behind the port the pages use. Onboarding is on Base; Home adds the other chains.
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useOwner, useSignAllowance, useSubscriptionSigning, useUpgradeAccount } from '../privy/index.ts'
import { type Auth, AuthContext, signInStatus } from './auth.tsx'

/** How long a sign-in may stay unfinished before the page offers to try again or sign out. */
const STALL_AFTER_MS = 20_000

/** True once `waiting` has held for `STALL_AFTER_MS`; it resets when the wait ends. */
function useStalled(waiting: boolean): boolean {
  const [stalled, setStalled] = useState(false)
  useEffect(() => {
    if (!waiting) return
    const timer = setTimeout(() => setStalled(true), STALL_AFTER_MS)
    return () => {
      clearTimeout(timer)
      setStalled(false)
    }
  }, [waiting])
  return waiting && stalled
}

export function PrivyAuthProvider({ children }: { readonly children: ReactNode }) {
  const owner = useOwner()
  const upgrader = useUpgradeAccount()
  const allowance = useSignAllowance()
  const subscriptions = useSubscriptionSigning()
  // The hooks return fresh objects each render; the latest ones are read at call time so `auth` can stay stable.
  const live = useRef({ owner, upgrader, allowance, subscriptions })
  useEffect(() => {
    live.current = { owner, upgrader, allowance, subscriptions }
  })
  const stalled = useStalled(signInStatus({ ...owner, stalled: false }) === 'loading')
  const status = signInStatus({ ...owner, stalled })
  const address = owner.address
  const auth = useMemo<Auth>(
    () => ({
      status,
      ...(address === undefined ? {} : { address }),
      getToken: () => live.current.owner.getToken(),
      login: () => live.current.owner.login(),
      logout: () => void live.current.owner.logout(),
      upgrade: async (chain, onStep) => {
        const operation = await live.current.upgrader.upgrade(chain, onStep)
        return operation.status === 'confirmed' ? 'confirmed' : 'submitted'
      },
      signAllowance: async (input) => {
        await live.current.allowance.sign(input)
      },
      signSubscription: (view) => live.current.subscriptions.sign(view),
      cancelSubscription: (view) => live.current.subscriptions.cancel(view),
    }),
    [status, address],
  )
  return <AuthContext value={auth}>{children}</AuthContext>
}
