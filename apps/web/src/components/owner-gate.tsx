import type { ReactNode } from 'react'
import { useOwnerSession } from '../lib/session.ts'
import { Authentication } from './authentication.tsx'

/** Renders `children` for the signed-in owner, the sign-in form otherwise. */
export function OwnerGate({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useOwnerSession()
  if (state === 'checking') return <p role="status">Opening your workspace…</p>
  if (state === 'signed-out') return <Authentication onAuthenticated={() => setState('signed-in')} />
  return children
}
