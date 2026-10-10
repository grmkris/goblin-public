import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@goblin/ui'
import { AuthShell } from '../components/auth-shell.tsx'
import { OwnerGate } from '../components/owner-gate.tsx'
import { awaitedBillingQuery } from '../account/queries.ts'
import { messageOf } from '../lib/query/app-error.ts'

/** How often the payment return asks whether the plan is active, and for how long before it asks the owner to check. */
const POLL_MS = 5000
const PATIENCE_MS = 5 * 60_000

export const Route = createFileRoute('/subscribe/success')({ component: SuccessPage })
function SuccessPage() {
  return (
    <OwnerGate planRequired={false}>
      <PaymentReturn />
    </OwnerGate>
  )
}
function PaymentReturn() {
  const [waiting, setWaiting] = useState(true)
  useEffect(() => {
    const timer = setTimeout(() => setWaiting(false), PATIENCE_MS)
    return () => clearTimeout(timer)
  }, [])
  // The page's one read: it waits for the plan, so a failure stays beside Check again rather than replacing the page.
  const billing = useQuery(awaitedBillingQuery(waiting, POLL_MS))
  const [checking, setChecking] = useState(false)
  async function checkAgain(): Promise<void> {
    setChecking(true)
    await billing.refetch()
    setChecking(false)
  }
  if (billing.data?.active)
    return (
      <AuthShell title="Your agent is ready" description="Pro is active.">
        <Button size="lg" className="w-full" nativeButton={false} render={<Link to="/" />}>
          Open your agent
        </Button>
      </AuthShell>
    )
  return (
    <AuthShell
      title="Confirming your subscription"
      description={
        waiting
          ? 'Waiting for the payment to be confirmed. This can take a moment.'
          : 'Confirmation is taking longer. Check again, or contact support with your checkout receipt.'
      }
      footer={
        <p>
          <Link to="/subscribe">Back to the subscription</Link>
        </p>
      }
    >
      <div className="auth-body" role="status">
        {billing.error !== null && <p role="alert">{messageOf(billing.error, 'check your subscription')}</p>}
        <Button size="lg" variant="outline" className="w-full" pending={checking} onClick={() => void checkAgain()}>
          Check again
        </Button>
      </div>
    </AuthShell>
  )
}
