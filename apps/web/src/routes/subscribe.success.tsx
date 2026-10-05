import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Button, Card, CardContent, CardHeader, CardTitle } from '@purrable/ui'
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
  return (
    <Card>
      <CardHeader>
        <CardTitle>{state?.active ? 'Your agent is ready' : 'Confirming your subscription'}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          {state?.active ? (
            <>
              <p>Pro is active. You can open your agent and add a passkey in Settings.</p>
              <a href="/" className="underline">
                Open your agent
              </a>
              <a href="/settings" className="underline">
                Add a passkey
              </a>
            </>
          ) : (
            <>
              <p role="status">
                {waiting
                  ? 'Waiting for payment confirmation. This can take a moment.'
                  : 'Confirmation is taking longer. Check again or contact support with your checkout receipt.'}
              </p>
              {error && <p role="alert">{error}</p>}
              <Button variant="outline" onClick={() => void refresh()}>
                Check again
              </Button>
              <a href="/subscribe" className="underline">
                Back to subscription
              </a>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
