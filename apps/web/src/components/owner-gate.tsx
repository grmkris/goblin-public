import type { ReactNode } from 'react'
import { useSession } from '../lib/session.tsx'
import { Authentication } from './authentication.tsx'

/** Renders `children` for the signed-in owner, the sign-in form otherwise. */
export function OwnerGate({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useSession()
  if (state === 'checking')
    return (
      <p role="status" className="gate-status">
        Opening your workspace…
      </p>
    )
  if (state === 'signed-out') return <Authentication onAuthenticated={() => setState('signed-in')} />
  return children
}
