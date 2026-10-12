// `/subscribe/:id`: a merchant asks the owner to sign a subscription once (ADR 0054). The page says what the chain will
// hold the merchant to, in four terms, and signs only after rebuilding the delegation from those terms and comparing it
// with the wallet's (`useSubscriptionSigning`). Signed, it goes back to the merchant's page the wallet vouched for.
import { Alert, AlertDescription, AlertTitle, Badge, Button, Card, CardContent, GoblinMark, Spinner } from '@goblin/ui'
import type { SubscriptionView } from '@goblin/wallet/contract'
import { useMutation } from '@tanstack/react-query'
import { Check, Link2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useMe, useStatus, useSubscription } from '../api/queries.tsx'
import { useAuth } from '../app/auth.tsx'
import { Async, errorText } from '../ui/async.tsx'
import { AddressChip } from '../ui/index.ts'
import { formatUsdCompact } from '../ui/format.ts'
import { usdOf } from '../views/money.ts'
import { FocusPage } from './focus.tsx'
import {
  billingTail,
  declinedUrl,
  firstPaymentNote,
  merchantSite,
  planName,
  shortfallOf,
  termsOf,
} from './subscription-model.ts'

/** The ask's figure: the dollars large, the cents beside them smaller, in tabular figures. */
function Price({ amountUsd }: { readonly amountUsd: string }) {
  const [whole = '0', cents = ''] = amountUsd.split('.')
  const fraction = cents.padEnd(2, '0').slice(0, 2)
  return (
    <span
      className="flex items-baseline leading-none font-semibold tracking-tight tabular-nums"
      aria-label={`$${whole}.${fraction}`}
    >
      <span aria-hidden className="text-5xl">
        ${whole}
      </span>
      <span aria-hidden className="text-3xl">
        .{fraction}
      </span>
    </span>
  )
}

function Detail({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center justify-end gap-1.5 text-end">{children}</dd>
    </div>
  )
}

/** The four terms the chain enforces, each with a tick: what the owner signs, never more. */
function Terms({ view }: { readonly view: SubscriptionView }) {
  return (
    <section aria-labelledby="sign-terms" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="sign-terms" className="text-base font-semibold tracking-tight">
          What you sign
        </h2>
        <Badge variant="secondary">
          <Link2 data-icon="inline-start" />
          Enforced on-chain
        </Badge>
      </div>
      <ul className="flex flex-col divide-y divide-foreground/8 rounded-xl bg-muted px-4">
        {termsOf(view).map((term) => (
          <li key={term.id} className="grid grid-cols-[1.25rem_1fr] gap-3 py-3">
            <span
              aria-hidden
              className="mbs-0.5 flex size-5 items-center justify-center rounded-full bg-moss text-moss-foreground"
            >
              <Check className="size-3" strokeWidth={3} />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
                {term.title}
                {term.id === 'recipient' && <AddressChip address={view.collector} chain={view.chain} />}
              </span>
              <span className="text-13/snug text-muted-foreground text-pretty">{term.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** What the page cannot sign yet: the account not set up on Base, or too little USDC there for the first payment. */
function Readiness({ view }: { readonly view: SubscriptionView }) {
  const me = useMe()
  const status = useStatus()
  const here = encodeURIComponent(window.location.href)
  const upgraded = me.data?.chains.find((setup) => setup.chain === 'base')?.upgraded === true
  if (me.data !== undefined && !upgraded)
    return (
      <Alert>
        <AlertTitle>Finish setting up your wallet first</AlertTitle>
        <AlertDescription>
          <p>
            Your account signs this on Base, where it is not set up yet. It takes a minute, then you come back here.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mbs-2"
            nativeButton={false}
            render={<a href={`/setup?return=${here}`} />}
          >
            Set up your wallet
          </Button>
        </AlertDescription>
      </Alert>
    )
  const short = shortfallOf(view, status.data)
  if (short === undefined || short === 0n) return null
  const note = firstPaymentNote(view, formatUsdCompact(usdOf(short)))
  return (
    <Alert>
      <AlertTitle>{note.title}</AlertTitle>
      <AlertDescription>
        <p>{note.text}</p>
        <Button
          size="sm"
          variant="outline"
          className="mbs-2"
          nativeButton={false}
          render={<a href={`/add-funds?return=${here}`} />}
        >
          Add funds
        </Button>
      </AlertDescription>
    </Alert>
  )
}

/** The ask: the price and its period, what the owner signs, who asks, and Sign or Cancel. */
function Ask({ view }: { readonly view: SubscriptionView }) {
  const auth = useAuth()
  const me = useMe()
  const sign = useMutation({
    mutationFn: () => auth.signSubscription(view),
    onSuccess: (signed) => window.location.assign(signed.returnUrl),
  })
  const ready = me.data?.chains.find((setup) => setup.chain === 'base')?.upgraded === true
  const busy = sign.isPending || sign.isSuccess
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <h1 className="text-sm text-muted-foreground">{view.merchant} asks for a subscription</h1>
        <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <Price amountUsd={view.amountUsd} />
          <span className="text-lg font-medium tracking-tight text-muted-foreground text-balance">
            {billingTail(view)}
          </span>
        </p>
        <p className="flex items-center gap-2.5 text-sm">
          <span
            aria-hidden
            className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-moss text-moss-foreground"
          >
            <GoblinMark className="size-4" />
          </span>
          <span className="font-semibold">{planName(view)}</span>
          <span className="text-muted-foreground">in USDC from your balance</span>
        </p>
      </div>
      <Terms view={view} />
      <dl className="flex flex-col divide-y divide-border border-y border-border">
        <Detail label="Asked by">{view.merchantHost}</Detail>
        <Detail label="Gas">{view.merchant} pays it, in USDC</Detail>
        <Detail label="Terms">
          <Check aria-hidden className="size-4 text-success" strokeWidth={2.5} />
          Checked again before you sign
        </Detail>
      </dl>
      <Readiness view={view} />
      {sign.isError && (
        <Alert variant="destructive">
          <AlertDescription>{errorText(sign.error)} Nothing was signed.</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col gap-2">
        <Button type="button" size="cta" disabled={!ready || busy} onClick={() => sign.mutate()}>
          {busy && <Spinner data-icon="inline-start" />}
          {sign.isSuccess ? `Back to ${view.merchantHost}` : 'Sign'}
        </Button>
        <Button
          type="button"
          size="cta"
          variant="outline"
          disabled={busy}
          nativeButton={false}
          render={<a href={declinedUrl(view)} />}
        >
          Cancel
        </Button>
      </div>
      <p className="text-center text-xs text-muted-foreground text-balance">
        The chain enforces every term, whatever {view.merchant} does. You can cancel any time in your wallet.
      </p>
    </div>
  )
}

/** A request already answered, or run out: what happened, and the way back to the merchant. */
function Settled({ view }: { readonly view: SubscriptionView }) {
  const [title, text, href] =
    view.status === 'active'
      ? ['You are subscribed', `${planName(view)} is signed. Its payments show in Activity.`, view.returnUrl]
      : view.status === 'revoked'
        ? ['This subscription is cancelled', 'Nothing more is taken from your account.', merchantSite(view)]
        : [
            'This request ran out',
            `Nothing was signed. Ask for ${planName(view)} again on ${view.merchantHost}.`,
            merchantSite(view),
          ]
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-balance">{title}</h1>
        <p className="text-sm text-muted-foreground text-pretty">{text}</p>
      </div>
      <Button size="cta" nativeButton={false} render={<a href={href} />}>
        Back to {view.merchantHost}
      </Button>
    </div>
  )
}

export function SubscribePage({ subscriptionId }: { readonly subscriptionId: string }) {
  const subscription = useSubscription(subscriptionId)
  return (
    <FocusPage>
      <Async query={subscription}>
        {(view) => (
          <Card>
            <CardContent>{view.status === 'pending' ? <Ask view={view} /> : <Settled view={view} />}</CardContent>
          </Card>
        )}
      </Async>
    </FocusPage>
  )
}
