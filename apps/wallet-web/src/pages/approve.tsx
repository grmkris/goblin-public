import { Alert, AlertDescription, AlertTitle, Button, Card, CardContent, Label, Spinner, Switch } from '@goblin/ui'
import type { ApprovalReason, ApprovalView } from '@goblin/wallet/contract'
import { useState } from 'react'
import { useApproval, useDecide } from '../api/queries.tsx'
import { Async, errorText } from '../ui/async.tsx'
import {
  AddressChip,
  Amount,
  ChainBadge,
  formatUsd,
  LAYERS,
  LayerBadge,
  PERIOD_LABEL,
  shortAddress,
  timeUntil,
} from '../ui/index.ts'
import { FocusPage } from './focus.tsx'
import { useTermsCheck } from './terms-check.ts'

const REASON: Record<ApprovalReason, string> = {
  over_limit: 'This payment crosses a limit you set.',
  new_recipient: 'This is the first payment to this address.',
  new_service: 'This service is not on your allowed list yet.',
  policy_change: 'Your agent asks to change a limit.',
}

const RAIL: Record<string, string> = {
  x402: 'x402',
  mpp: 'MPP',
  transfer: 'Direct transfer',
  lifi: 'LI.FI',
  relay: 'Relay',
  delegation: 'Allowance',
  userop: 'Account operation',
}

function Detail({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-end break-words">{children}</dd>
    </div>
  )
}

function Final({ view }: { readonly view: ApprovalView }) {
  const text = {
    approved: ['Approved', 'You can return to goblin. The payment goes ahead within your limits.'],
    declined: ['Declined', 'Your agent was told no. Nothing was spent. You can return to goblin.'],
    expired: ['Expired', 'This request ran out of time. Nothing was spent. Ask your agent to try again.'],
    pending: ['', ''],
  }[view.status]
  return (
    <Alert>
      <AlertTitle>{text[0]}</AlertTitle>
      <AlertDescription>{text[1]}</AlertDescription>
    </Alert>
  )
}

function Terms({ view }: { readonly view: ApprovalView }) {
  const { terms } = view
  const url = terms.request === undefined ? undefined : new URL(terms.request.url)
  return (
    <dl className="flex flex-col divide-y divide-border border-y border-border">
      <Detail label="To">
        <span className="font-medium">{terms.subject}</span>
        {url !== undefined && (
          <span className="block text-xs text-muted-foreground">
            {terms.request?.method} {url.host}
            {url.pathname}
          </span>
        )}
      </Detail>
      <Detail label="Paid to">
        <AddressChip address={terms.recipient} chain={terms.chain} />
      </Detail>
      <Detail label="Chain">
        <ChainBadge chain={terms.chain} />
      </Detail>
      <Detail label="Rail">{RAIL[terms.rail] ?? terms.rail}</Detail>
      <Detail label="Asked by">{view.client}</Detail>
      <Detail label="Expires">{timeUntil(view.expiresAt)}</Detail>
    </dl>
  )
}

function Crossed({ view }: { readonly view: ApprovalView }) {
  if (view.crosses.length === 0) return null
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">Limits this crosses</h2>
      <ul className="flex flex-col gap-3">
        {view.crosses.map((limit) => (
          <li key={`${limit.layer}-${limit.period}`} className="flex flex-col gap-1.5 rounded-lg bg-muted p-3">
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium tabular-nums">
                {PERIOD_LABEL[limit.period]}: {formatUsd(limit.limit)}
              </span>
              <LayerBadge layer={limit.layer} />
            </span>
            <span className="text-xs/relaxed text-muted-foreground">
              {limit.enforcedBy}. {LAYERS[limit.layer].promise}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Decision({ view }: { readonly view: ApprovalView }) {
  const check = useTermsCheck(view)
  const decide = useDecide(view.operationId)
  const [remember, setRemember] = useState(false)
  const canRemember = view.reason === 'new_recipient' || view.reason === 'new_service'
  const answer = (decision: 'approve' | 'decline'): void =>
    decide.mutate({ decision, termsHash: view.termsHash, ...(canRemember && remember ? { remember: true } : {}) })
  const blocked = check !== 'match' || decide.isPending
  return (
    <div className="flex flex-col gap-4">
      {check === 'mismatch' && (
        <Alert variant="destructive">
          <AlertTitle>These terms do not match their fingerprint</AlertTitle>
          <AlertDescription>Do not approve this. Decline it and ask your agent to try again.</AlertDescription>
        </Alert>
      )}
      {decide.isError && (
        <Alert variant="destructive">
          <AlertDescription>{errorText(decide.error)} Nothing was spent. You can try again.</AlertDescription>
        </Alert>
      )}
      {canRemember && (
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="remember">
            {view.reason === 'new_service' ? 'Allow this service from now on' : 'Add this address to my address book'}
          </Label>
          <Switch id="remember" checked={remember} onCheckedChange={setRemember} />
        </div>
      )}
      <div className="flex flex-col gap-2 sm:flex-row-reverse">
        <Button type="button" size="lg" disabled={blocked} onClick={() => answer('approve')} className="sm:flex-1">
          {(decide.isPending || check === 'checking') && <Spinner data-icon="inline-start" />}
          Approve
        </Button>
        <Button
          type="button"
          size="lg"
          variant="outline"
          disabled={decide.isPending}
          onClick={() => answer('decline')}
          className="sm:flex-1"
        >
          Decline
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {check === 'match'
          ? `Terms fingerprint ${shortAddress(view.termsHash)} checked in your browser.`
          : check === 'checking'
            ? 'Checking the terms fingerprint.'
            : 'The fingerprint check failed.'}
      </p>
    </div>
  )
}

function Body({ view }: { readonly view: ApprovalView }) {
  const decided = view.status !== 'pending'
  return (
    <Card>
      <CardContent>
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <h1 className="text-sm text-muted-foreground">{REASON[view.reason]}</h1>
            <Amount
              usd={view.terms.amountUsd}
              token={{ symbol: view.terms.token.symbol, amount: view.terms.amount }}
              size="hero"
            />
          </div>
          <Terms view={view} />
          <Crossed view={view} />
          {decided ? <Final view={view} /> : <Decision view={view} />}
        </div>
      </CardContent>
    </Card>
  )
}

/** `/approve/:operationId`: the frozen terms of one spend, and the owner's answer. */
export function ApprovePage({ operationId }: { readonly operationId: string }) {
  const approval = useApproval(operationId)
  return (
    <FocusPage>
      <Async query={approval}>{(view) => <Body view={view} />}</Async>
    </FocusPage>
  )
}
