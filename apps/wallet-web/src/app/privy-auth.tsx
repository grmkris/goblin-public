// The real Auth: lane S's Privy hooks behind the port the pages use. Onboarding is on Base for now.
import { type ReactNode, useEffect, useMemo, useRef } from 'react'
import { useOwner, useSignAllowance, useUpgradeAccount } from '../privy/index.ts'
import { type Auth, AuthContext } from './auth.tsx'

export function PrivyAuthProvider({ children }: { readonly children: ReactNode }) {
  const owner = useOwner()
  const upgrader = useUpgradeAccount('base')
  const allowance = useSignAllowance('base')
  // The hooks return fresh objects each render; the latest ones are read at call time so `auth` can stay stable.
  const live = useRef({ owner, upgrader, allowance })
  useEffect(() => {
    live.current = { owner, upgrader, allowance }
  })
  const status =
    !owner.ready || (owner.authenticated && owner.address === undefined)
      ? 'loading'
      : owner.authenticated
        ? 'ready'
        : 'signed-out'
  const address = owner.address
  const auth = useMemo<Auth>(
    () => ({
      status,
      ...(address === undefined ? {} : { address }),
      getToken: () => live.current.owner.getToken(),
      login: () => live.current.owner.login(),
      logout: () => void live.current.owner.logout(),
      upgrade: async () => {
        await live.current.upgrader.upgrade()
      },
      signAllowance: async ({ perHour, days }) => {
        await live.current.allowance.sign({ perHour, days })
      },
    }),
    [status, address],
  )
  return <AuthContext value={auth}>{children}</AuthContext>
}
