import { useState } from 'react'
import { Schema } from 'effect'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@purrable/ui'
import { failureText, request } from '../lib/boundary.ts'
import { useBilling } from '../lib/billing.tsx'

const Link = Schema.Struct({ url: Schema.String })
const Checkout = Schema.Struct({ checkoutUrl: Schema.String })
const date = (at: number) => new Date(at).toLocaleDateString()
export function BillingCard() {
  const { state, error } = useBilling()
  const [failure, setFailure] = useState('')
  const [pending, setPending] = useState(false)
  async function manage() {
    setPending(true)
    try {
      const link = Schema.decodeUnknownSync(Link)(await request('/api/billing/portal', { body: {} }))
      window.location.assign(link.url)
    } catch (cause) {
      setFailure(failureText(cause))
      setPending(false)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Billing</CardTitle>
        <CardDescription>Pro · $10/month · 2 million weighted tokens per day.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          {(error || failure) && (
            <Alert variant="destructive">
              <AlertDescription>{failure || error}</AlertDescription>
            </Alert>
          )}
          <p>
            {state === undefined
              ? 'Loading…'
              : state.active
                ? 'Pro is active.'
                : 'Subscribe to use your personal agent.'}
          </p>
          {state?.until != null && (
            <p className="text-sm text-muted-foreground">
              {state.cancelAtPeriodEnd || state.status === 'cancelled'
                ? 'Access until'
                : state.status === 'past_due' || state.status === 'on_hold'
                  ? 'Payment grace until'
                  : 'Renews on'}{' '}
              {date(state.until)}.
            </p>
          )}
          {state?.hasCustomer ? (
            <Button variant="outline" disabled={pending} onClick={() => void manage()}>
              {pending ? 'Opening…' : 'Manage subscription'}
            </Button>
          ) : (
            state?.active === false && (
              <a href="/subscribe" className="underline">
                Choose Pro
              </a>
            )
          )}
          <p className="text-sm text-muted-foreground">
            Cancel in the billing portal. Access continues through your paid period. Cancel your subscription before
            deleting your account.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
export function Subscribe() {
  const { state, error } = useBilling()
  const [failure, setFailure] = useState('')
  const [pending, setPending] = useState(false)
  async function checkout() {
    setPending(true)
    try {
      const link = Schema.decodeUnknownSync(Checkout)(await request('/api/billing/checkout', { body: {} }))
      window.location.assign(link.checkoutUrl)
    } catch (cause) {
      setFailure(failureText(cause))
      setPending(false)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Your own resident agent</CardTitle>
        <CardDescription>Pro · $10/month</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-5">
          <p>
            Talk in your browser, connect your tools and give your agent work to carry on with. Pro includes 2 million
            weighted tokens per day, resetting at midnight UTC.
          </p>
          <p className="text-sm text-muted-foreground">
            No trial. Billed monthly. Cancel any time; your agent stays available until the end of the paid period.
            Model prices affect how quickly the allowance is used.
          </p>
          {(error || failure) && (
            <Alert variant="destructive">
              <AlertDescription>{failure || error}</AlertDescription>
            </Alert>
          )}
          {state?.active ? (
            <a href="/" className="underline">
              Open your agent
            </a>
          ) : (
            <Button disabled={pending || state?.mode == null} onClick={() => void checkout()}>
              {pending
                ? 'Opening checkout…'
                : state?.mode === 'test_mode'
                  ? 'Continue to test checkout'
                  : 'Subscribe for $10/month'}
            </Button>
          )}
          {state !== undefined && state.mode === null && !state.active && (
            <p role="status">Checkout is being set up. Please try again later.</p>
          )}
          <p className="text-sm text-muted-foreground">
            By subscribing you accept the{' '}
            <a className="underline" href="/terms">
              terms
            </a>
            . Read our{' '}
            <a className="underline" href="/privacy">
              privacy
            </a>{' '}
            and{' '}
            <a className="underline" href="/refunds">
              refund
            </a>{' '}
            policies.
          </p>
          <a className="text-sm underline" href="/settings">
            Account settings
          </a>
        </div>
      </CardContent>
    </Card>
  )
}
