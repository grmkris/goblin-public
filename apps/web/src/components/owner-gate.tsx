import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Alert, AlertDescription, Button } from '@goblin/ui'
import { useSession } from '../lib/session.tsx'
import { useBilling } from '../lib/billing.tsx'
import { Navigate } from '@tanstack/react-router'
import { Authentication } from './authentication.tsx'
import { authMessageOf, sessionQuery } from '../auth/queries.ts'

/** The session could not be checked: say so, with the reference to quote, and offer to check again. */
function SessionUnavailable({ onRetry }: { readonly onRetry: () => void }) {
  const { error } = useQuery(sessionQuery)
  return (
    <div className="gate-status">
      <Alert variant="destructive">
        <AlertDescription>{authMessageOf(error, 'check whether you are signed in')}</AlertDescription>
      </Alert>
      <div className="card-actions">
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  )
}

/** Renders `children` for the signed-in owner, the sign-in form otherwise. */
export function OwnerGate({
  children,
  planRequired = true,
}: {
  readonly children: ReactNode
  readonly planRequired?: boolean
}) {
  const [state, setState, recheck] = useSession()
  const billing = useBilling()
  if (state === 'checking')
    return (
      <p role="status" className="gate-status">
        Opening your workspace…
      </p>
    )
  if (state === 'unavailable') return <SessionUnavailable onRetry={recheck} />
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
