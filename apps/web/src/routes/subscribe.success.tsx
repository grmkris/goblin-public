import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Button } from '@goblin/ui'
import { AuthShell } from '../components/auth-shell.tsx'
import { OwnerGate } from '../components/owner-gate.tsx'
import { useBilling } from '../lib/billing.tsx'
export const Route = createFileRoute('/subscribe/success')({ component: SuccessPage })
function SuccessPage() {
  return (
    <OwnerGate planRequired={false}>
      <PaymentReturn />
    </OwnerGate>
  )
}
function PaymentReturn() {
  const { state, error, refresh } = useBilling()
  const [waiting, setWaiting] = useState(true)
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    if (state?.active) return
    let attempts = 0
    const timer = setInterval(() => {
      if (++attempts >= 60) {
        clearInterval(timer)
        setWaiting(false)
      }
      void refresh()
    }, 5000)
    return () => clearInterval(timer)
  }, [state?.active, refresh])
  if (state?.active)
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
        {error && <p role="alert">{error}</p>}
        <Button
          size="lg"
          variant="outline"
          className="w-full"
          pending={checking}
          onClick={() => {
            setChecking(true)
            void refresh().finally(() => setChecking(false))
          }}
        >
          Check again
        </Button>
      </div>
    </AuthShell>
  )
}
