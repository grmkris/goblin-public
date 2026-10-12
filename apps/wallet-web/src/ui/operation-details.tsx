// What an operation is called and everything recorded about it, shared by the activity rows and the receipt view.
import type { Operation, OperationKind, Rail } from '@goblin/wallet/contract'
import { ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Step } from '../views/receipt-model.ts'
import { AddressChip } from './address-chip.tsx'
import { ChainBadge } from './chain-badge.tsx'
import { txUrl } from './chains.ts'
import { cn } from './cn.ts'
import { CopyButton } from './copy-button.tsx'
import { timeAgo } from './format.ts'

export const KIND: Record<OperationKind, string> = {
  paid_fetch: 'Paid request',
  transfer: 'Transfer',
  swap: 'Swap',
  bridge: 'Bridge',
  upgrade: 'Account upgrade',
  allowance: 'Allowance',
}

export const RAIL: Record<Rail, string> = {
  x402: 'x402',
  mpp: 'MPP',
  transfer: 'Direct transfer',
  lifi: 'LI.FI',
  relay: 'Relay',
  delegation: 'Allowance',
}

/** The colour of a payment or delivery step's dot; the label beside it carries the meaning. */
export const STEP_DOT: Record<Step['tone'], string> = {
  ok: 'bg-success',
  wait: 'bg-attention',
  bad: 'bg-destructive',
  quiet: 'bg-muted-foreground/50',
}

/** The explorer page of the operation's transaction, when one was recorded. */
const transactionUrl = ({ payment, terms }: Operation): string | undefined =>
  payment?.explorerUrl ?? (payment?.txHash === undefined ? undefined : txUrl(terms.chain, payment.txHash))

function Detail({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center justify-end text-sm">{children}</dd>
    </div>
  )
}

/**
 * Everything recorded about one operation, and what is missing: an operation without a transaction says none was
 * recorded rather than leaving the row out, so an unknown outcome can still be checked by its id.
 */
export function OperationDetails({
  operation,
  className,
}: {
  readonly operation: Operation
  readonly className?: string
}) {
  const { terms, payment, delivery } = operation
  const tx = transactionUrl(operation)
  return (
    <dl className={cn('flex flex-col divide-y divide-border', className)}>
      <Detail label="Network">
        <ChainBadge chain={terms.chain} />
        <span className="ms-2 text-muted-foreground">{RAIL[terms.rail]}</span>
      </Detail>
      <Detail label="Recipient">
        <AddressChip address={terms.recipient} chain={terms.chain} />
      </Detail>
      {terms.request !== undefined && (
        <Detail label="Request">
          <span className="truncate text-muted-foreground" title={terms.request.url}>
            {terms.request.method} {terms.request.url.replace(/^https:\/\//u, '')}
          </span>
        </Detail>
      )}
      <Detail label="Transaction">
        {tx === undefined ? (
          <span className="text-muted-foreground">None recorded</span>
        ) : (
          <a
            href={tx}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-10 items-center gap-1 rounded-sm underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring pointer-fine:hover:underline"
          >
            View on explorer
            <ExternalLink aria-hidden className="size-3" />
          </a>
        )}
      </Detail>
      {payment?.reference !== undefined && (
        <Detail label="Payment receipt">
          <span className="truncate text-muted-foreground" title={payment.reference}>
            {payment.reference}
          </span>
        </Detail>
      )}
      {delivery?.detail !== undefined && (
        <Detail label="Delivery note">
          <span className="truncate text-muted-foreground">{delivery.detail}</span>
        </Detail>
      )}
      <Detail label="Operation">
        <span className="truncate text-muted-foreground tabular-nums">{operation.id}</span>
        <CopyButton text={operation.id} label="Copy operation id" compact />
      </Detail>
      <Detail label="Updated">
        <span className="text-muted-foreground">{timeAgo(operation.updatedAt)}</span>
      </Detail>
    </dl>
  )
}
