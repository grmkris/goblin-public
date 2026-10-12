import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from '@goblin/ui'
import type { Operation } from '@goblin/wallet/contract'
import { ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'
import { amountMeaning, deliveryStep, paymentStep, type Step } from '../views/receipt-model.ts'
import { Amount } from './amount.tsx'
import { ChainBadge } from './chain-badge.tsx'
import { cn } from './cn.ts'
import { timeAgo } from './format.ts'
import { KIND, OperationDetails, RAIL, STEP_DOT } from './operation-details.tsx'

function StepState({ title, step }: { readonly title: string; readonly step: Step }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap">
      <span className="text-muted-foreground">{title}</span>
      <span aria-hidden className={cn('size-1.5 rounded-full', STEP_DOT[step.tone])} />
      <span className="font-medium">{step.label}</span>
    </span>
  )
}

/**
 * One operation: what it was for, what it cost and whether that was asked for, held, paid or not charged, then the
 * payment and the delivery as two separate answers. An outcome that is not known says so and that the money stays
 * reserved; nothing here pays again. Details open on every row, with or without a transaction.
 */
export function ReceiptRow({
  operation,
  action,
  className,
}: {
  readonly operation: Operation
  /** What the owner can do about it, e.g. review an approval. */
  readonly action?: ReactNode
  readonly className?: string
}) {
  const { terms } = operation
  const payment = paymentStep(operation)
  const delivery = deliveryStep(operation)
  return (
    <Collapsible>
      <div className={cn('flex min-w-0 flex-col gap-1 py-3', className)}>
        <div className="flex min-w-0 items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="truncate text-sm font-medium">{terms.subject}</span>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <span>{KIND[terms.kind]}</span>
              <ChainBadge chain={terms.chain} />
              <span>{RAIL[terms.rail]}</span>
              <span>{timeAgo(operation.createdAt)}</span>
            </span>
            <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <StepState title="Payment" step={payment} />
              {delivery !== undefined && <StepState title="Delivery" step={delivery} />}
            </span>
          </div>
          <span className="flex shrink-0 flex-col items-end gap-1">
            <Amount usd={terms.amountUsd} token={{ symbol: terms.token.symbol, amount: terms.amount }} align="end" />
            <span className="text-xs text-muted-foreground">{amountMeaning(operation)}</span>
          </span>
        </div>
        {operation.status === 'uncertain' && payment.detail !== undefined && (
          <p className="max-w-prose text-xs/relaxed text-foreground text-pretty">{payment.detail}</p>
        )}
        {operation.reason !== undefined && (
          <p className="max-w-prose text-xs/relaxed text-muted-foreground text-pretty">{operation.reason}</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {action}
          <CollapsibleTrigger
            render={<Button type="button" variant="ghost" size="sm" className="group/details -ms-2.5" />}
          >
            Details
            <ChevronDown
              data-icon="inline-end"
              aria-hidden
              className="group-data-panel-open/details:rotate-180 motion-safe:transition-transform"
            />
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <OperationDetails operation={operation} className="pb-1" />
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
