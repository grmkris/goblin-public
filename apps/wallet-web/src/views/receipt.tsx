// The receipt: what was bought, what it cost (the largest figure), how it ended, with payment and delivery told apart.
// A quote or a spend waiting for the owner shows the way to approve it, through the host and never a popup.
import type { LimitView, Operation, SpendResult } from '@goblin/wallet/contract'
import { Button } from '@goblin/ui'
import { ExternalLink } from 'lucide-react'
import { Amount, cn, PERIOD_LABEL, StatusPill, formatUsd, timeUntil } from '../ui/index.ts'
import { KIND, OperationDetails, STEP_DOT } from '../ui/operation-details.tsx'
import { byMicros, microsOf } from './money.ts'
import { amountMeaning, deliveryStep, paymentStep, type Step } from './receipt-model.ts'

function StepRow({ title, step }: { readonly title: string; readonly step: Step }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <span className="text-sm text-muted-foreground">{title}</span>
      <span className="flex min-w-0 flex-col items-end gap-0.5 text-end">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium">
          <span aria-hidden className={cn('size-1.5 rounded-full', STEP_DOT[step.tone])} />
          {step.label}
        </span>
        {step.detail !== undefined && <span className="text-xs/relaxed text-muted-foreground">{step.detail}</span>}
      </span>
    </div>
  )
}

function Approval({
  operation,
  approveUrl,
  onOpenLink,
}: {
  readonly operation: Operation
  readonly approveUrl: string | undefined
  readonly onOpenLink: (url: string) => void
}) {
  const quote = operation.status === 'quoted'
  return (
    <section aria-label="Approval" className="flex flex-col gap-3 rounded-xl p-4 ring-1 ring-attention/60">
      <p className="text-sm/relaxed">
        {quote
          ? 'This is a quote. Nothing has been paid.'
          : 'Your agent is waiting for you. Nothing is paid until you approve the exact terms below.'}{' '}
        <span className="text-muted-foreground">Terms hold {timeUntil(operation.terms.expiresAt)}.</span>
      </p>
      {approveUrl !== undefined ? (
        <Button type="button" onClick={() => onOpenLink(approveUrl)}>
          Review and approve
          <ExternalLink aria-hidden />
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">Your agent will send you the approval link.</p>
      )}
    </section>
  )
}

/** The tightest metered limit still standing: what is left of it after this spend. */
function LimitsLeft({ limits }: { readonly limits: readonly LimitView[] }) {
  const metered = limits
    .filter((limit) => limit.remaining !== undefined)
    .toSorted((a, b) => byMicros(microsOf(a.remaining ?? '0'), microsOf(b.remaining ?? '0')))
  const tightest = metered.slice(0, 2)
  if (tightest.length === 0) return null
  return (
    <section aria-label="Limits left" className="flex flex-col gap-1 text-sm">
      <h2 className="text-sm font-medium">Left to spend</h2>
      {tightest.map((limit) => (
        <p key={`${limit.layer}-${limit.period}-${limit.chain ?? ''}`} className="text-muted-foreground tabular-nums">
          <span className="text-foreground">{formatUsd(limit.remaining ?? '0')}</span> of {formatUsd(limit.limit)}{' '}
          {PERIOD_LABEL[limit.period].toLowerCase()}, enforced by {limit.enforcedBy}
        </p>
      ))}
    </section>
  )
}

export function Receipt({
  result,
  approveUrl,
  limits,
  onOpenLink,
}: {
  readonly result: SpendResult
  readonly approveUrl: string | undefined
  readonly limits: readonly LimitView[]
  readonly onOpenLink: (url: string) => void
}) {
  const { operation } = result
  const { terms } = operation
  const waiting = operation.status === 'quoted' || operation.status === 'awaiting_approval'
  const delivery = deliveryStep(operation)
  return (
    <>
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-sm font-medium text-muted-foreground">{KIND[terms.kind]}</h1>
        <StatusPill status={operation.status} />
      </header>
      <section aria-label="Amount" className="flex flex-col gap-2">
        <Amount usd={terms.amountUsd} token={{ symbol: terms.token.symbol, amount: terms.amount }} size="hero" />
        <p className="text-sm text-muted-foreground">{amountMeaning(operation)}</p>
        <p className="text-base font-medium text-balance">{terms.subject}</p>
      </section>
      {waiting && <Approval operation={operation} approveUrl={approveUrl} onOpenLink={onOpenLink} />}
      <div className="flex flex-col divide-y divide-border border-y border-border">
        <StepRow title="Payment" step={paymentStep(operation)} />
        {delivery !== undefined && <StepRow title="Delivery" step={delivery} />}
      </div>
      <OperationDetails operation={operation} />
      <LimitsLeft limits={limits} />
    </>
  )
}
