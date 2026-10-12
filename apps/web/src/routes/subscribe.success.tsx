import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { WalletReceipt } from '@goblin/contracts'
import { Alert, AlertDescription, Button } from '@goblin/ui'
import { ExternalLinkIcon } from 'lucide-react'
import { AuthShell } from '../components/auth-shell.tsx'
import { OwnerGate } from '../components/owner-gate.tsx'
import { useBilling } from '../account/hooks.ts'
import { awaitedBillingQuery, walletConfirmMutation } from '../account/queries.ts'
import { dayAndMonth } from '../lib/format.ts'
import { describeError, messageOf } from '../lib/query/app-error.ts'
import { parseSubscribedSearch } from '../lib/subscribe-search.ts'
import { reportUnexpected } from '../lib/unexpected.ts'

/** How often the payment return asks whether the plan is active, and for how long before it asks the owner to check. */
const POLL_MS = 5000
const PATIENCE_MS = 5 * 60_000

/**
 * Where a payment comes back to: the card checkout (ADR 0015), or the Goblin Wallet with the subscription the owner
 * signed (`?subscription=`) or declined (`?declined=1`), ADR 0054.
 */
export const Route = createFileRoute('/subscribe/success')({
  validateSearch: parseSubscribedSearch,
  component: SuccessPage,
})
function SuccessPage() {
  const { subscription, declined, return: back } = Route.useSearch()
  return (
    <OwnerGate planRequired={false}>
      {declined === true ? (
        <Declined back={back} />
      ) : subscription === undefined ? (
        <PaymentReturn />
      ) : (
        <WalletReturn subscription={subscription} back={back} />
      )}
    </OwnerGate>
  )
}

/** Back to the page the owner came from (a path the search parser checked), or the app. */
function useGoBack(back: string | undefined): () => void {
  const navigate = useNavigate()
  return () => {
    const href = back ?? '/'
    navigate({ href }).catch((error: unknown) => {
      reportUnexpected(error)
      window.location.assign(href)
    })
  }
}

/** The owner pressed Cancel in the wallet: nothing was signed, nothing paid. */
function Declined({ back }: { readonly back: string | undefined }) {
  const goBack = useGoBack(back)
  return (
    <AuthShell title="You did not subscribe" description="Nothing was signed and nothing was paid.">
      <div className="auth-body">
        <Button
          size="lg"
          className="w-full"
          nativeButton={false}
          render={<Link to="/subscribe" search={back === undefined ? {} : { return: back }} />}
        >
          Back to goblin Pro
        </Button>
        <Button size="lg" variant="outline" className="w-full" onClick={goBack}>
          Not now
        </Button>
      </div>
    </AuthShell>
  )
}

/** "$10.00". */
const dollars = (amountUsd: string): string => `$${Number(amountUsd).toFixed(2)}`

/** The first period's receipt: paid, how much, for which days, its transaction, and what comes next. */
function Receipt({ receipt }: { readonly receipt: WalletReceipt }) {
  const days =
    receipt.paidFrom === null || receipt.paidThrough === null
      ? undefined
      : `${dayAndMonth(receipt.paidFrom)} to ${dayAndMonth(receipt.paidThrough)}`
  return (
    <section className="sub-receipt" aria-label="Receipt">
      <div className="sub-receipt-head">
        <span>Subscription payment</span>
        <span>Paid</span>
      </div>
      <div className="sub-receipt-amount">
        <b>{dollars(receipt.amountUsd)}</b>
        <span>{`${String(Number(receipt.amountUsd))} USDC`}</span>
      </div>
      <dl className="sub-receipt-rows">
        <div>
          <dt>Plan</dt>
          <dd>goblin Pro</dd>
        </div>
        {days !== undefined && (
          <div>
            <dt>Period</dt>
            <dd>{days}</dd>
          </div>
        )}
        <div>
          <dt>Paid from</dt>
          <dd>Your Goblin Wallet</dd>
        </div>
      </dl>
      {receipt.paidThrough !== null && (
        <p className="sub-receipt-next">
          Next: {dollars(receipt.amountUsd)} on {dayAndMonth(receipt.paidThrough)}. At most that every{' '}
          {String(receipt.periodDays)} days, enforced on-chain. Cancel any time in your wallet.
        </p>
      )}
      {receipt.explorerUrl !== undefined && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          nativeButton={false}
          render={<a href={receipt.explorerUrl} target="_blank" rel="noreferrer" />}
        >
          View transaction
          <ExternalLinkIcon data-icon="inline-end" />
        </Button>
      )}
    </section>
  )
}

/**
 * Back from the Goblin Wallet with a signed subscription: goblin takes the first payment (once, however often this
 * asks), then shows the receipt and the way back. A payment still landing is asked about again every few seconds.
 */
function WalletReturn({ subscription, back }: { readonly subscription: string; readonly back: string | undefined }) {
  const confirm = useMutation(walletConfirmMutation)
  const { state } = useBilling()
  const goBack = useGoBack(back)
  const { mutate } = confirm
  const pending = confirm.data?.status === 'pending'
  useEffect(() => {
    mutate(subscription)
  }, [mutate, subscription])
  useEffect(() => {
    if (!pending) return
    const timer = setTimeout(() => mutate(subscription), POLL_MS)
    return () => clearTimeout(timer)
  }, [pending, mutate, subscription])
  if (confirm.data?.status === 'paid')
    return (
      <AuthShell
        title="You're on Pro"
        description="The first payment went through. A copy of the receipt is in your chat."
      >
        <div className="auth-body">
          <Receipt receipt={confirm.data} />
          <Button size="lg" className="w-full" onClick={goBack}>
            Continue
          </Button>
        </div>
      </AuthShell>
    )
  const short = confirm.error !== null && describeError(confirm.error).code === 'payment_short'
  const addFunds = state?.wallet === undefined ? undefined : new URL('/add-funds', state.wallet.manageUrl).href
  return (
    <AuthShell
      title="Confirming your subscription"
      description="goblin is taking the first payment from your Goblin Wallet. This takes a moment."
      footer={
        <p>
          <Link to="/subscribe" search={back === undefined ? {} : { return: back }}>
            Back to goblin Pro
          </Link>
        </p>
      }
    >
      <div className="auth-body" role="status">
        {confirm.error !== null && (
          <Alert variant="destructive">
            <AlertDescription>
              {messageOf(confirm.error, 'confirm your subscription', { showRecovery: true })}
            </AlertDescription>
          </Alert>
        )}
        {short && addFunds !== undefined && (
          <Button size="lg" variant="outline" className="w-full" nativeButton={false} render={<a href={addFunds} />}>
            Add funds in your wallet
          </Button>
        )}
        <Button
          size="lg"
          variant={confirm.error === null ? 'outline' : 'default'}
          className="w-full"
          pending={confirm.isPending || pending}
          onClick={() => mutate(subscription)}
        >
          Try again
        </Button>
      </div>
    </AuthShell>
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
      <AuthShell
        title="Your agent is ready"
        description="Pro is active. Connect Mercator next, so goblin can search the web and get outside work done for you."
      >
        <Button size="lg" className="w-full" nativeButton={false} render={<Link to="/" />}>
          Open your agent
        </Button>
        <Button
          size="lg"
          variant="outline"
          className="w-full"
          nativeButton={false}
          render={<Link to="/connections" hash="connection-mercator" />}
        >
          Connect Mercator
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
