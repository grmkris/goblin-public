import { useState } from 'react'
import { Schema } from 'effect'
import type { BillingState } from '@purrable/contracts'
import { Link } from '@tanstack/react-router'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
} from '@purrable/ui'
import { failureText, request } from '../lib/boundary.ts'
import { useBilling } from '../lib/billing.tsx'
import { planStatus } from '../lib/labels.ts'
import { StatusLabel } from './status-label.tsx'

const PortalLink = Schema.Struct({ url: Schema.String })
const Checkout = Schema.Struct({ checkoutUrl: Schema.String })
const date = (at: number) => new Date(at).toLocaleDateString()
/** When the paid period ends or renews, in words. */
function periodLine(state: BillingState): string {
  if (state.until === null)
    return state.active ? 'Included with your account.' : 'Subscribe to use your personal agent.'
  if (state.cancelAtPeriodEnd || state.status === 'cancelled') return `Access until ${date(state.until)}.`
  if (state.status === 'past_due' || state.status === 'on_hold') return `Payment grace until ${date(state.until)}.`
  return `Renews on ${date(state.until)}.`
}

export function BillingCard() {
  const { state, error } = useBilling()
  const [failure, setFailure] = useState('')
  const [pending, setPending] = useState(false)
  async function manage() {
    setPending(true)
    try {
      const link = Schema.decodeUnknownSync(PortalLink)(await request('/api/billing/portal', { body: {} }))
      window.location.assign(link.url)
    } catch (cause) {
      setFailure(failureText(cause))
      setPending(false)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pro</CardTitle>
        <CardDescription>$10 a month · 2 million weighted tokens a day</CardDescription>
        <CardAction>{state !== undefined && <StatusLabel label={planStatus(state)} />}</CardAction>
      </CardHeader>
      <CardContent>
        <div className="card-body">
          {(error || failure) && (
            <Alert variant="destructive">
              <AlertDescription>{failure || error}</AlertDescription>
            </Alert>
          )}
          {state === undefined ? <Skeleton className="h-5 w-48" /> : <p>{periodLine(state)}</p>}
          {state?.hasCustomer && (
            <div className="card-actions">
              <Button variant="outline" pending={pending} onClick={() => void manage()}>
                Manage subscription
              </Button>
            </div>
          )}
          {state?.active === false && !state.hasCustomer && (
            <div className="card-actions">
              <Button nativeButton={false} render={<Link to="/subscribe" />}>
                Choose Pro
              </Button>
            </div>
          )}
          {state?.hasCustomer && (
            <p className="server-note">
              Cancel in the billing portal; access continues through your paid period. Cancel before deleting your
              account.
            </p>
          )}
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
