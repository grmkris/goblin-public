import { useMutation, useQuery } from '@tanstack/react-query'
import type { BillingState, WalletPlan } from '@goblin/contracts'
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
  GoblinMark,
  Skeleton,
} from '@goblin/ui'
import { CheckIcon } from 'lucide-react'
import { checkoutMutation, portalMutation, walletStartMutation } from '../account/queries.ts'
import { useBilling } from '../account/hooks.ts'
import { onboardingQuery } from '../onboarding/queries.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { planStatus } from '../lib/labels.ts'
import { dayAndMonth, shortDate } from '../lib/format.ts'
import { AuthShell } from './auth-shell.tsx'
import { StatusLabel } from './status-label.tsx'

/** Whether the account has Pro: an active plan that is not the free one. */
const isPro = (state: BillingState): boolean => state.active && state.source !== 'free'

/** "$10", or "$9.50": the plan's price as its pages say it. */
const priceOf = (cents: number): string =>
  cents % 100 === 0 ? `$${String(cents / 100)}` : `$${(cents / 100).toFixed(2)}`

/** A wallet subscription's line on the plan card: when it is paid through, when it renews or ends (ADR 0054). */
function walletLine(wallet: WalletPlan): string {
  if (wallet.status === 'pending') return 'Signed in your Goblin Wallet; the first payment has not gone through yet.'
  if (wallet.status === 'lapsed') return 'The payment did not go through, so Pro has ended. Subscribe again any time.'
  const through = wallet.paidThrough === null ? '' : dayAndMonth(wallet.paidThrough)
  if (wallet.status === 'cancelled') return `Cancelled in your Goblin Wallet. Pro runs to ${through}.`
  if (wallet.status === 'grace')
    return `The last payment did not go through. goblin tries again each day until ${dayAndMonth(wallet.graceUntil ?? 0)}.`
  return `Paid through ${through}. Next, $${wallet.amountUsd.replace(/\.00?$/u, '')} from your Goblin Wallet.`
}

/** When the paid period ends or renews, in words. */
function periodLine(state: BillingState): string {
  if (state.source === 'free')
    return `Free: ${String(state.dailyCredits)} model Credits a day, no routines. Pro gives 800 a day and routines.`
  if (state.source === 'wallet' && state.wallet !== undefined) return walletLine(state.wallet)
  if (state.until === null)
    return state.active ? 'Included with your account.' : 'Subscribe to use your personal agent.'
  if (state.cancelAtPeriodEnd || state.status === 'cancelled') return `Access until ${shortDate(state.until)}.`
  if (state.status === 'past_due' || state.status === 'on_hold') return `Payment grace until ${shortDate(state.until)}.`
  return `Renews on ${shortDate(state.until)}.`
}

/** The card checkout's portal (ADR 0015), for an account that paid by card while it was on. */
function CardPortal() {
  const portal = useMutation(portalMutation)
  const manage = () => portal.mutate(undefined, { onSuccess: (link) => window.location.assign(link.url) })
  return (
    <>
      {portal.error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{messageOf(portal.error, 'open the billing portal')}</AlertDescription>
        </Alert>
      )}
      <div className="card-actions">
        <Button variant="outline" pending={portal.isPending || portal.isSuccess} onClick={manage}>
          Manage subscription
        </Button>
      </div>
      <p className="server-note">
        Cancel in the billing portal; access continues through your paid period. Cancel before deleting your account.
      </p>
    </>
  )
}

/** Settings' plan card: the plan, where it stands, and the way to Pro or to manage it. */
export function BillingCard() {
  const { state, error } = useBilling()
  const wallet = state?.wallet
  const lapsed = wallet === undefined || wallet.status === 'lapsed'
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pro</CardTitle>
        <CardDescription>
          {priceOf(state?.priceCents ?? 1000)} in USDC every 30 days · 800 model Credits a day
        </CardDescription>
        <CardAction>{state !== undefined && <StatusLabel label={planStatus(state)} />}</CardAction>
      </CardHeader>
      <CardContent>
        <div className="card-body">
          {error !== '' && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {state === undefined ? <Skeleton className="h-5 w-48" /> : <p>{periodLine(state)}</p>}
          {wallet !== undefined && !lapsed && (
            <div className="card-actions">
              <Button variant="outline" nativeButton={false} render={<a href={wallet.manageUrl} />}>
                Manage in your wallet
              </Button>
            </div>
          )}
          {state?.hasCustomer === true && state.cardCheckout === true && <CardPortal />}
          {state !== undefined && !isPro(state) && lapsed && (
            <div className="card-actions">
              <Button nativeButton={false} render={<Link to="/subscribe" search={{ return: '/settings' }} />}>
                Choose Pro
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/** What Pro includes, in the owner's words (`billing/plans.ts`). */
const INCLUDES = [
  ['800 Credits a day', "For your agent's model, every day."],
  ['Routines', 'Events and schedules that run while you are away.'],
  ['Subagents', 'Long jobs handed off and reported back.'],
] as const

/** The Goblin Wallet Pro is paid from: what it holds and how many payments that covers, once Start can read it. */
function PaidFrom({ state }: { readonly state: BillingState }) {
  // The wallet's balance, as Start reads it: only on a plan, since Start's view is the agent's.
  const view = useQuery({ ...onboardingQuery, enabled: state.active })
  const dollars = view.data?.wallet.dollars
  const covers = dollars === undefined ? undefined : Math.floor((Number(dollars) * 100) / state.priceCents)
  return (
    <div className="sub-wallet">
      <span className="sub-wallet-tile" aria-hidden>
        <GoblinMark />
      </span>
      <span className="sub-wallet-body">
        <span className="sub-wallet-name">Goblin Wallet</span>
        <span className="sub-wallet-sub">
          {covers === undefined
            ? 'Paid from your USDC on Base'
            : covers === 0
              ? `Add ${priceOf(state.priceCents)} before you subscribe`
              : `Covers ${String(covers)} ${covers === 1 ? 'payment' : 'payments'}`}
        </span>
      </span>
      {dollars !== undefined && (
        <span className="sub-wallet-amount">
          <b>${Number(dollars).toFixed(2)}</b>
          <span className="sub-wallet-sub">USDC</span>
        </span>
      )}
    </div>
  )
}

/** The way to Pro: the wallet subscription, and the card checkout only while the deployment has it on. */
function SubscribeActions({ state, back }: { readonly state: BillingState; readonly back: string | undefined }) {
  const start = useMutation(walletStartMutation)
  const checkout = useMutation(checkoutMutation)
  const subscribe = () => start.mutate(back, { onSuccess: (started) => window.location.assign(started.signUrl) })
  const card = () => checkout.mutate(undefined, { onSuccess: (link) => window.location.assign(link.checkoutUrl) })
  const failure = start.error ?? checkout.error
  return (
    <div className="sub-cta">
      {failure !== null && (
        <Alert variant="destructive">
          <AlertDescription>{messageOf(failure, 'start the subscription', { showRecovery: true })}</AlertDescription>
        </Alert>
      )}
      <Button
        size="lg"
        className="w-full"
        pending={start.isPending || start.isSuccess}
        disabled={state.walletPay !== true}
        onClick={subscribe}
      >
        Subscribe with USDC
      </Button>
      <p className="sub-cta-note">
        {state.walletPay === true
          ? 'You review and sign it in your Goblin Wallet.'
          : 'Paying from the Goblin Wallet is being set up. Please try again later.'}
      </p>
      {state.cardCheckout === true && state.mode !== null && (
        <Button size="lg" variant="outline" className="w-full" pending={checkout.isPending} onClick={card}>
          Pay by card instead
        </Button>
      )}
    </div>
  )
}

/** `/subscribe`: goblin Pro, $10 in USDC every 30 days, paid from the Goblin Wallet (ADR 0054). */
export function Subscribe({ back }: { readonly back?: string | undefined }) {
  const { state, error } = useBilling()
  const price = priceOf(state?.priceCents ?? 1000)
  return (
    <AuthShell
      size="lg"
      title="Your agent, working all day"
      description="goblin Pro"
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
        <div className="sub-price">
          <span className="sub-price-figure">{price}</span>
          <span className="sub-price-per">USDC every 30 days</span>
        </div>
        <p className="sub-lede">Paid from your Goblin Wallet. No card, nothing stored, cancel in one tap.</p>
        <ul className="sub-includes">
          {INCLUDES.map(([title, detail]) => (
            <li key={title}>
              <span className="sub-tick" aria-hidden>
                <CheckIcon />
              </span>
              <span>
                {title}
                <small>{detail}</small>
              </span>
            </li>
          ))}
        </ul>
        {error !== '' && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {state !== undefined && <PaidFrom state={state} />}
        <ol className="sub-steps">
          <li>
            <span className="sub-step-n">1</span>
            <span>
              You sign one permission in your wallet: <b>{price} to goblin, at most once every 30 days.</b>
            </span>
          </li>
          <li>
            <span className="sub-step-n">2</span>
            <span>goblin takes the first {price} now, then one payment each period. You get a receipt every time.</span>
          </li>
          <li>
            <span className="sub-step-n">3</span>
            <span>Cancel whenever you like. Pro runs to the end of the period you paid for.</span>
          </li>
        </ol>
        {state === undefined ? (
          <Skeleton className="h-10 w-full" />
        ) : isPro(state) ? (
          <Button size="lg" className="w-full" nativeButton={false} render={<Link to="/" />}>
            Open your agent
          </Button>
        ) : (
          <SubscribeActions state={state} back={back} />
        )}
      </div>
    </AuthShell>
  )
}
