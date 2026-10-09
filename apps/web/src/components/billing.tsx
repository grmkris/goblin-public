import { useMutation } from '@tanstack/react-query'
import type { BillingState } from '@goblin/contracts'
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
} from '@goblin/ui'
import { checkoutMutation, portalMutation } from '../lib/account/queries.ts'
import { useBilling } from '../lib/billing.tsx'
import { messageOf } from '../lib/query/app-error.ts'
import { planStatus } from '../lib/labels.ts'
import { AuthShell } from './auth-shell.tsx'
import { StatusLabel } from './status-label.tsx'

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
  const portal = useMutation(portalMutation)
  const manage = () => portal.mutate(undefined, { onSuccess: (link) => window.location.assign(link.url) })
  const failure = portal.error === null ? '' : messageOf(portal.error, 'open the billing portal')
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pro</CardTitle>
        <CardDescription>$10 a month · 800 model Credits a day</CardDescription>
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
              <Button variant="outline" pending={portal.isPending || portal.isSuccess} onClick={manage}>
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
  const checkout = useMutation(checkoutMutation)
  const start = () => checkout.mutate(undefined, { onSuccess: (link) => window.location.assign(link.checkoutUrl) })
  const failure = checkout.error === null ? '' : messageOf(checkout.error, 'open the checkout', { showRecovery: true })
  return (
    <AuthShell
      size="lg"
      title="Your own resident agent"
      description="Pro · $10 a month. No trial; cancel any time."
      footer={
        <>
          <p>
            By subscribing you accept the <Link to="/terms">terms</Link>. Read our <Link to="/privacy">privacy</Link>{' '}
            and <Link to="/refunds">refund</Link> policies.
          </p>
          <p>
            <Link to="/settings">Account settings</Link>
          </p>
        </>
      }
    >
      <div className="auth-body">
        <ul className="plan-points">
          <li>Talk to it in your browser, and connect the tools you choose it may use.</li>
          <li>Give it work to carry on with: routines run at a time, on a schedule or when a server sends an event.</li>
          <li>800 model Credits a day, about 2 million tokens, starting again at midnight UTC.</li>
        </ul>
        <p className="server-note">
          Billed monthly; your agent stays available until the end of the paid period. Credits price model use the way
          the model plan does: writing costs more than reading, and context the model has seen before costs much less.
        </p>
        {(error || failure) && (
          <Alert variant="destructive">
            <AlertDescription>{failure || error}</AlertDescription>
          </Alert>
        )}
        {state?.active ? (
          <Button size="lg" className="w-full" nativeButton={false} render={<Link to="/" />}>
            Open your agent
          </Button>
        ) : (
          <Button
            size="lg"
            className="w-full"
            pending={checkout.isPending || checkout.isSuccess}
            disabled={state?.mode == null}
            onClick={start}
          >
            {state?.mode === 'test_mode' ? 'Continue to test checkout' : 'Subscribe for $10 a month'}
          </Button>
        )}
        {state !== undefined && state.mode === null && !state.active && (
          <p role="status" className="server-note">
            Checkout is being set up. Please try again later.
          </p>
        )}
      </div>
    </AuthShell>
  )
}
