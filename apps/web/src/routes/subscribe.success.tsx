import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Button, Card, CardContent, CardHeader, CardTitle } from '@purrable/ui'
import { OwnerGate } from '../components/owner-gate.tsx'
import { useBilling } from '../lib/billing.tsx'
import { Schema } from 'effect'
import { InvitationPreview } from '@purrable/contracts'
import { request } from '../lib/boundary.ts'
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
  const [invitation, setInvitation] = useState<InvitationPreview | null>(null)
  useEffect(() => {
    void request('/api/invitations/admission')
      .then((data) => setInvitation(Schema.decodeUnknownSync(Schema.NullOr(InvitationPreview))(data)))
      .catch(() => undefined)
  }, [])
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
              <a href={invitation ? `/invite/${invitation.id}` : '/'} className="underline">
                {invitation ? 'Finish joining your workspace' : 'Open your agent'}
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
