import type { ReactNode } from 'react'
import { useSession } from '../lib/session.tsx'
import { useBilling } from '../lib/billing.tsx'
import { Navigate } from '@tanstack/react-router'
import { Authentication } from './authentication.tsx'

/** Renders `children` for the signed-in owner, the sign-in form otherwise. */
export function OwnerGate({
  children,
  planRequired = true,
}: {
  readonly children: ReactNode
  readonly planRequired?: boolean
}) {
  const [state, setState] = useSession()
  const billing = useBilling()
  if (state === 'checking')
    return (
      <p role="status" className="gate-status">
        Opening your workspace…
      </p>
    )
  if (state === 'signed-out') return <Authentication onAuthenticated={() => setState('signed-in')} />
  if (planRequired && billing.error) return <p role="alert">{billing.error}</p>
  if (planRequired && billing.state === undefined)
    return (
      <p role="status" className="gate-status">
        Checking your subscription…
      </p>
    )
  if (planRequired && billing.state?.active === false) return <Navigate to="/subscribe" replace />
  return children
}
