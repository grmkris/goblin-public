import type { ReactNode } from 'react'
import { useSession } from '../lib/session.tsx'
import { useBilling } from '../lib/billing.tsx'
import { Navigate } from '@tanstack/react-router'
import { Authentication } from './authentication.tsx'
import { useAccountWorkspaces } from '../lib/account-workspaces.tsx'

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
  const workspaces = useAccountWorkspaces()
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
  if (planRequired && workspaces.error) return <p role="alert">{workspaces.error}</p>
  if (planRequired && workspaces.state === undefined)
    return (
      <p role="status" className="gate-status">
        Checking your workspace…
      </p>
    )
  if (planRequired && workspaces.state?.active?.agentReady !== true)
    return (
      <div className="shell">
        <p>Shared agent access is being prepared. Your membership is saved.</p>
        <a href="/settings" className="underline">
          Manage your workspace in Settings
        </a>
      </div>
    )
  return children
}
