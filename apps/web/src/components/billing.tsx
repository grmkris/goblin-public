import { useMutation } from '@tanstack/react-query'
import type { BillingId, BillingState, PlanOffer } from '@goblin/contracts'
import { Link } from '@tanstack/react-router'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
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
import { useGoblinWallet } from '../mcp/hooks.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { planStatus } from '../lib/labels.ts'
import {
  type ChoiceAction,
  addFundsUrl,
  choiceAction,
  choiceOf,
  coverageLine,
  coverageOf,
  creditsOf,
  dayPassFundsUrl,
  held,
  offerOf,
  planLine,
  planSummary,
  unpaidDayPass,
  usd,
} from '../lib/pro.ts'
import { AuthShell } from './auth-shell.tsx'
import { StatusLabel } from './status-label.tsx'
import { useMinute } from './use-now.ts'

/** This app's absolute URL for `path`: where the Goblin Wallet sends the owner back to. */
const appUrl = (path: string): string => new URL(path, location.origin).href

/** `/subscribe`, coming back to `back` once subscribed. */
const subscribePath = (back: string | undefined): string =>
  back === undefined ? '/subscribe' : `/subscribe?return=${encodeURIComponent(back)}`

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

/**
 * The plan card's ways on: add funds to a day pass that could not pay, manage the subscription in the wallet, move a
 * day pass to monthly, or pick a way to pay without a plan. Each comes back to Settings.
 */
function PlanActions({ state }: { readonly state: BillingState }) {
  const wallet = state.wallet
  const unpaid = unpaidDayPass(state)
  const fundsUrl = unpaid === undefined ? undefined : dayPassFundsUrl(unpaid, location.origin, '/settings')
  const manageUrl =
    wallet !== undefined && wallet.status !== 'lapsed' && (state.active || wallet.status === 'pending')
      ? wallet.manageUrl
      : undefined
  const moveUp = choiceAction(state, 'month') === 'switch'
  const pick = !state.active
  if (fundsUrl === undefined && manageUrl === undefined && !moveUp && !pick) return null
  return (
    <div className="card-actions">
      {fundsUrl !== undefined && (
        <Button nativeButton={false} render={<a href={fundsUrl} />}>
          Add funds
        </Button>
      )}
      {manageUrl !== undefined && (
        <Button variant="outline" nativeButton={false} render={<a href={manageUrl} />}>
          Manage in your wallet
        </Button>
      )}
      {moveUp && (
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link to="/subscribe" search={{ return: '/settings' }} />}
        >
          Switch to monthly
        </Button>
      )}
      {pick && (
        <Button
          variant={fundsUrl === undefined ? 'default' : 'outline'}
          nativeButton={false}
          render={<Link to="/subscribe" search={{ return: '/settings' }} />}
        >
          Pick a plan
        </Button>
      )}
    </div>
  )
}

/** Settings' plan card: goblin Pro, how it is paid and where that stands, and the way to it or to manage it. */
export function BillingCard() {
  const { state, error } = useBilling()
  const now = useMinute() * 1000
  return (
    <Card>
      <CardHeader>
        <CardTitle>goblin Pro</CardTitle>
        <CardDescription>
          {state === undefined ? 'Paid in USDC from your Goblin Wallet' : planSummary(state)}
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
          {state === undefined ? <Skeleton className="h-5 w-48" /> : <p>{planLine(state, now)}</p>}
          {state !== undefined && <PlanActions state={state} />}
          {state?.hasCustomer === true && state.cardCheckout === true && <CardPortal />}
        </div>
      </CardContent>
    </Card>
  )
}

/** What Pro includes, in the owner's words (`billing/plans.ts`); its Credits from the deployment's catalog. */
function Includes({ credits }: { readonly credits: number | undefined }) {
  const items = [
    ['Hand-overs to goblin or a Persona', 'Events and schedules handled for you while you are away.'],
    [
      credits === undefined ? 'Daily Credits' : `${String(credits)} Credits a day`,
      "For your agent's model, every day.",
    ],
    ['Subagents', 'Long jobs handed off and reported back.'],
  ] as const
  return (
    <ul className="sub-includes">
      {items.map(([title, detail]) => (
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
  )
}

/** The Goblin Wallet Pro is paid from, and what its status says it holds once it can be read. */
function PaidFrom({ dollars }: { readonly dollars: number | undefined }) {
  return (
    <div className="sub-wallet">
      <span className="sub-wallet-tile" aria-hidden>
        <GoblinMark />
      </span>
      <span className="sub-wallet-body">
        <span className="sub-wallet-name">Goblin Wallet</span>
        <span className="sub-wallet-sub">
          {dollars === undefined ? 'Pro is paid from your USDC on Base' : 'What your wallet holds now'}
        </span>
      </span>
      {dollars !== undefined && (
        <span className="sub-wallet-amount">
          <b>{held(dollars)}</b>
          <span className="sub-wallet-sub">USDC</span>
        </span>
      )}
    </div>
  )
}

/** What one way to pay offers this account, and what it takes: its action, its pending state and the line under it. */
interface ChoiceProps {
  readonly offer: PlanOffer
  readonly action: ChoiceAction
  readonly pending: boolean
  readonly disabled: boolean
  readonly hint: string | undefined
  /** Where the hint goes when it asks for funds: the wallet's Add funds page. */
  readonly hintUrl: string | undefined
  /** The Add funds page for a day pass that could not pay. */
  readonly fundsUrl: string | undefined
  readonly onStart: (plan: BillingId) => void
}

/** One way to pay: its name, its price and who it suits, then its one action. */
function ChoiceCard({ offer, action, pending, disabled, hint, hintUrl, fundsUrl, onStart }: ChoiceProps) {
  const choice = choiceOf(offer)
  const label = action === 'switch' ? `Switch to ${choice.name.toLowerCase()}` : 'Subscribe with USDC'
  return (
    <li className="sub-choice" {...(action === 'current' || action === 'fund' ? { 'data-current': '' } : {})}>
      <div className="sub-choice-head">
        <h2 className="sub-choice-name">{choice.name}</h2>
        {action === 'current' && <Badge variant="secondary">Your plan</Badge>}
      </div>
      <p className="sub-choice-price">
        <span className="sub-choice-figure">{choice.price}</span>
        <span className="sub-choice-per">{choice.per}</span>
      </p>
      <p className="sub-choice-suits">{choice.suits}</p>
      {(action === 'subscribe' || action === 'switch') && (
        <>
          <Button
            size="cta"
            className="mbs-2 w-full"
            pending={pending}
            disabled={disabled}
            onClick={() => onStart(offer.id)}
          >
            {label}
          </Button>
          {hint !== undefined && (
            <p className="sub-choice-hint">{hintUrl === undefined ? hint : <a href={hintUrl}>{hint}</a>}</p>
          )}
        </>
      )}
      {action === 'fund' && fundsUrl !== undefined && (
        <>
          <Button size="cta" className="mbs-2 w-full" nativeButton={false} render={<a href={fundsUrl} />}>
            Add funds
          </Button>
          <p className="sub-choice-hint">
            Your day pass is signed. goblin takes the day&apos;s {choice.price} when you are back.
          </p>
        </>
      )}
    </li>
  )
}

/**
 * The day pass and monthly side by side where the column holds both, one above the other on a phone, each with its
 * own Subscribe with USDC; the card checkout only while the deployment has it on.
 */
function Choices({
  state,
  back,
  dollars,
  endpoint,
}: {
  readonly state: BillingState
  readonly back: string | undefined
  readonly dollars: number | undefined
  readonly endpoint: string | undefined
}) {
  const start = useMutation(walletStartMutation)
  const checkout = useMutation(checkoutMutation)
  const begin = (plan: BillingId) =>
    start.mutate({ plan, back }, { onSuccess: (started) => window.location.assign(started.signUrl) })
  const card = () => checkout.mutate(undefined, { onSuccess: (link) => window.location.assign(link.checkoutUrl) })
  const failure = start.error ?? checkout.error
  const going = start.isPending || start.isSuccess
  const unpaid = unpaidDayPass(state)
  const fundsUrl = unpaid === undefined ? undefined : dayPassFundsUrl(unpaid, location.origin, back)
  // Short of a way to pay: the wallet's Add funds page (from goblin's own wallet link, else the connection's endpoint),
  // back to this page.
  const walletUrl = state.wallet?.manageUrl ?? endpoint
  const topUp = walletUrl === undefined ? undefined : addFundsUrl(walletUrl, appUrl(subscribePath(back)))
  return (
    <section className="sub-choose" aria-label="Ways to pay">
      {failure !== null && (
        <Alert variant="destructive">
          <AlertDescription>{messageOf(failure, 'start the subscription', { showRecovery: true })}</AlertDescription>
        </Alert>
      )}
      <ul className="sub-choices">
        {state.catalog.map((offer) => {
          const coverage = dollars === undefined ? undefined : coverageOf(dollars, offer)
          return (
            <ChoiceCard
              key={offer.id}
              offer={offer}
              action={choiceAction(state, offer.id)}
              pending={going && start.variables?.plan === offer.id}
              disabled={state.walletPay !== true || going}
              hint={coverage === undefined ? undefined : coverageLine(coverage, offer.id)}
              hintUrl={coverage !== undefined && 'short' in coverage ? topUp : undefined}
              fundsUrl={fundsUrl}
              onStart={begin}
            />
          )
        })}
      </ul>
      <p className="sub-cta-note">
        {state.walletPay !== true
          ? 'Paying from the Goblin Wallet is being set up. Please try again later.'
          : choiceAction(state, 'month') === 'switch'
            ? 'You review and sign it in your Goblin Wallet. Your day pass stops once the first monthly payment goes through.'
            : 'You review and sign it in your Goblin Wallet.'}
      </p>
      {!state.active && state.cardCheckout === true && state.mode !== null && (
        <Button size="lg" variant="outline" className="w-full" pending={checkout.isPending} onClick={card}>
          Pay by card instead
        </Button>
      )}
    </section>
  )
}

/** How paying works, in order: sign once, what each way takes and when, and cancelling. */
function Steps({ catalog }: { readonly catalog: BillingState['catalog'] }) {
  const day = offerOf(catalog, 'day')
  const month = offerOf(catalog, 'month')
  const most = [
    day === undefined ? undefined : `${usd(day.amountUsd)} a day`,
    month === undefined ? undefined : `${usd(month.amountUsd)} every ${String(month.periodDays)} days`,
  ].filter((part) => part !== undefined)
  return (
    <ol className="sub-steps">
      <li>
        <span className="sub-step-n">1</span>
        <span>
          You sign one permission in your Goblin Wallet: <b>at most {most.join(', or ')}, to goblin.</b>
        </span>
      </li>
      <li>
        <span className="sub-step-n">2</span>
        <span>
          {day !== undefined &&
            `The day pass takes ${usd(day.amountUsd)} with your first message on each day you use goblin. `}
          {month !== undefined &&
            `Monthly takes ${usd(month.amountUsd)} now, then once every ${String(month.periodDays)} days.`}
        </span>
      </li>
      <li>
        <span className="sub-step-n">3</span>
        <span>Cancel whenever you like in your wallet. Pro runs to the end of what you paid for.</span>
      </li>
    </ol>
  )
}

/** `/subscribe`: goblin Pro, paid as a day pass or monthly in USDC from the Goblin Wallet (ADR 0054). */
export function Subscribe({ back }: { readonly back?: string | undefined }) {
  const { state, error } = useBilling()
  const wallet = useGoblinWallet()
  const unpaid = unpaidDayPass(state)
  return (
    <AuthShell
      size="lg"
      title="Your agent, working all day"
      description="goblin Pro, paid in USDC from your Goblin Wallet. No card, nothing stored, cancel in your wallet."
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
        {error !== '' && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {unpaid !== undefined && (
          <Alert>
            <AlertTitle>Your day pass could not take {usd(unpaid.amountUsd)} for today</AlertTitle>
            <AlertDescription>
              goblin is paused until your Goblin Wallet has the funds. Add them below.
            </AlertDescription>
          </Alert>
        )}
        <Includes credits={state === undefined ? undefined : creditsOf(state.catalog)} />
        <PaidFrom dollars={wallet.dollars} />
        {state === undefined ? (
          <Skeleton className="h-56 w-full" />
        ) : (
          <Choices state={state} back={back} dollars={wallet.dollars} endpoint={wallet.endpoint} />
        )}
        {state !== undefined && <Steps catalog={state.catalog} />}
        {state?.active === true && (
          <Button size="lg" variant="outline" className="w-full" nativeButton={false} render={<Link to="/" />}>
            Open your agent
          </Button>
        )}
      </div>
    </AuthShell>
  )
}
