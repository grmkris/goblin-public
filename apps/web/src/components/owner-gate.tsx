import type { ReactNode } from 'react'
import { Alert, AlertDescription, Button } from '@goblin/ui'
import { Navigate } from '@tanstack/react-router'
import { useBilling } from '../account/hooks.ts'
import { useSession } from '../auth/hooks.ts'
import { messageOf } from '../lib/query/app-error.ts'
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
 * Renders `children` for the signed-in owner, the sign-in form otherwise. `pending` is what shows while the session is
 * checked (first-run Start shows goblin's splash there). Whether a page waits for Start is the shell's to decide
 * (`staticData.startRequired`, `useStartDecision`), before anything of the app is drawn.
 */
export function OwnerGate({
  children,
  planRequired = true,
  pending,
}: {
  readonly children: ReactNode
  readonly planRequired?: boolean
  readonly pending?: ReactNode
}) {
  const session = useSession()
  const billing = useBilling()
  const { state } = session
  if (state === 'checking')
    return (
      pending ?? (
        <p role="status" className="gate-status">
          Opening your workspace…
        </p>
      )
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
  return children
}
