import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@goblin/ui'
import type { Operation, OperationCheck, OperationKind, OperationStatus } from '@goblin/wallet/contract'
import { ArrowLeftRight, ArrowUpRight, Globe, KeyRound, Route, ShieldCheck } from 'lucide-react'
import type { ComponentType, ReactNode, SVGProps } from 'react'
import { deliveryStep, paymentStep, type Step } from '../views/receipt-model.ts'
import { CheckStatus } from './check-status.tsx'
import { cn } from './cn.ts'
import { formatUsd } from './format.ts'
import { KIND, OperationDetails, STEP_DOT } from './operation-details.tsx'
import { StatusPill } from './status-pill.tsx'

const ICON: Record<OperationKind, ComponentType<SVGProps<SVGSVGElement>>> = {
  paid_fetch: Globe,
  transfer: ArrowUpRight,
  swap: ArrowLeftRight,
  bridge: Route,
  upgrade: ShieldCheck,
  allowance: KeyRound,
}

/** Nothing left the wallet: the amount is shown struck through, as a card statement shows a declined charge. */
const NOT_CHARGED: ReadonlySet<OperationStatus> = new Set(['quoted', 'failed', 'expired', 'declined', 'cancelled'])

function StepLine({ title, step }: { readonly title: string; readonly step: Step }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">{title}</span>
      <span aria-hidden className={cn('size-1.5 rounded-full', STEP_DOT[step.tone])} />
      <span className="font-medium">{step.label}</span>
    </span>
  )
}

/**
 * One operation as a wallet lists it: what it was, when, what it cost and how it stands. The row opens in place to the
 * payment and the delivery as separate answers and everything recorded about it. An approval keeps its Review step
 * and an unconfirmed payment its Check status in view, outside the fold.
 */
export function ActivityRow({
  operation,
  time,
  action,
  onCheck,
}: {
  readonly operation: Operation
  /** When it happened, in the form the list around it needs ("5 min ago", "14:05"). */
  readonly time: string
  /** What the owner can do about it now, e.g. review an approval. */
  readonly action?: ReactNode
  /** How this page asks the chain about an unconfirmed operation; without it there is no Check status. */
  readonly onCheck?: ((operation: Operation) => Promise<OperationCheck>) | undefined
}) {
  const { terms, status } = operation
  const Icon = ICON[terms.kind]
  const payment = paymentStep(operation)
  const delivery = deliveryStep(operation)
  const check = status === 'uncertain' && onCheck !== undefined
  return (
    <Collapsible>
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className="-mx-4 flex min-h-16 w-[calc(100%+2rem)] items-center gap-3 px-4 py-3 text-start transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring active:bg-muted/60 pointer-fine:hover:bg-muted/40"
          />
        }
      >
        <span
          aria-hidden
          title={KIND[terms.kind]}
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
        >
          <Icon className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-sm font-medium">
            {terms.subject}
            <span className="sr-only">, {KIND[terms.kind]}</span>
          </span>
          <span className="flex min-w-0 items-center text-xs text-muted-foreground">
            <StatusPill status={status} className="shrink-0" />
            <span className="truncate">, {time}</span>
          </span>
        </span>
        <span
          className={cn(
            'shrink-0 self-start pt-px text-sm font-medium tabular-nums',
            NOT_CHARGED.has(status) && 'text-muted-foreground line-through decoration-muted-foreground/60',
          )}
        >
          {formatUsd(terms.amountUsd)}
        </span>
      </CollapsibleTrigger>
      {(action !== undefined || check) && (
        <div className="flex flex-wrap items-center gap-2 ps-12 pb-3">
          {action}
          {check && <CheckStatus operation={operation} onCheck={onCheck} />}
        </div>
      )}
      <CollapsibleContent>
        <div className="flex flex-col gap-2 ps-12 pb-3">
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <StepLine title="Payment" step={payment} />
            {delivery !== undefined && <StepLine title="Delivery" step={delivery} />}
          </span>
          {payment.detail !== undefined && status === 'uncertain' && (
            <p className="text-xs/relaxed text-pretty">{payment.detail}</p>
          )}
          {operation.reason !== undefined && (
            <p className="text-xs/relaxed text-muted-foreground text-pretty">{operation.reason}</p>
          )}
          <OperationDetails operation={operation} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
