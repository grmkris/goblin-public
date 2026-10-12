import type { ReactNode } from 'react'
import { Alert, AlertDescription, Button } from '@goblin/ui'
import { useQuery } from '@tanstack/react-query'
import { Navigate } from '@tanstack/react-router'
import { useBilling } from '../account/hooks.ts'
import { useSession } from '../auth/hooks.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { onboardingStateQuery } from '../onboarding/queries.ts'
import { Authentication } from './authentication.tsx'

/** The session could not be checked: say so, with the reference to quote, and offer to check again. */
function SessionUnavailable({ error, onRetry }: { readonly error: unknown; readonly onRetry: () => void }) {
  return (
    <div className="gate-status">
      <Alert variant="destructive">
        <AlertDescription>{messageOf(error, 'check whether you are signed in')}</AlertDescription>
      </Alert>
      <div className="card-actions">
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  )
}

/**
 * First-run Start (ADR 0048) stands before the chats while it is open. A state that cannot be read lets the owner in:
 * Start is help, not a lock.
 */
function StartGate({ children }: { readonly children: ReactNode }) {
  const start = useQuery(onboardingStateQuery)
  if (start.data === undefined && start.error === null)
    return (
      <p role="status" className="gate-status">
        Opening your workspace…
      </p>
    )
  if (start.data?.status === 'open') return <Navigate to="/start/$step" params={{ step: 'wallet' }} replace />
  return children
}

/**
 * Renders `children` for the signed-in owner, the sign-in form otherwise. `startRequired` sends an owner who has not
 * been through first-run Start there first.
 */
export function OwnerGate({
  children,
  planRequired = true,
  startRequired = false,
}: {
  readonly children: ReactNode
  readonly planRequired?: boolean
  readonly startRequired?: boolean
}) {
  const session = useSession()
  const billing = useBilling()
  const { state } = session
  if (state === 'checking')
    return (
      <p role="status" className="gate-status">
        Opening your workspace…
      </p>
    )
  if (state === 'unavailable') return <SessionUnavailable error={session.error} onRetry={session.recheck} />
  if (state === 'signed-out') return <Authentication onAuthenticated={session.signedIn} />
  if (planRequired && billing.error) return <p role="alert">{billing.error}</p>
  if (planRequired && billing.state === undefined)
    return (
      <p role="status" className="gate-status">
        Checking your subscription…
      </p>
    )
  if (planRequired && billing.state?.active === false) return <Navigate to="/subscribe" replace />
  return startRequired ? <StartGate>{children}</StartGate> : children
}
