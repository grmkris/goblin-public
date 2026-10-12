import type { Operation, OperationKind } from '@goblin/wallet/contract'
import { ExternalLink } from 'lucide-react'
import { Amount } from './amount.tsx'
import { ChainBadge } from './chain-badge.tsx'
import { txUrl } from './chains.ts'
import { cn } from './cn.ts'
import { timeAgo } from './format.ts'
import { StatusPill } from './status-pill.tsx'

const KIND: Record<OperationKind, string> = {
  paid_fetch: 'Paid request',
  transfer: 'Transfer',
  swap: 'Swap',
  bridge: 'Bridge',
  upgrade: 'Account upgrade',
  allowance: 'Allowance',
}

const RAIL: Record<string, string> = {
  x402: 'x402',
  mpp: 'MPP',
  transfer: 'Direct transfer',
  lifi: 'LI.FI',
  relay: 'Relay',
  delegation: 'Allowance',
}

/** One operation: what it bought, what it cost (the largest figure), where, over which rail, how it ended. */
export function ReceiptRow({ operation, className }: { readonly operation: Operation; readonly className?: string }) {
  const { terms, payment } = operation
  const tx = payment?.explorerUrl ?? (payment?.txHash === undefined ? undefined : txUrl(terms.chain, payment.txHash))
  return (
    <div className={cn('flex min-w-0 items-start justify-between gap-4 py-3', className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-sm font-medium">{terms.subject}</span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span>{KIND[terms.kind]}</span>
          <ChainBadge chain={terms.chain} />
          <span>{RAIL[terms.rail] ?? terms.rail}</span>
          <span>{timeAgo(operation.createdAt)}</span>
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <StatusPill status={operation.status} />
          {tx !== undefined && (
            <a
              href={tx}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-6 items-center gap-1 rounded-sm text-xs text-muted-foreground underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring pointer-fine:hover:text-foreground pointer-fine:hover:underline"
            >
              Transaction
              <ExternalLink aria-hidden className="size-3" />
            </a>
          )}
        </span>
        {operation.reason !== undefined && <span className="text-xs text-muted-foreground">{operation.reason}</span>}
      </div>
      <Amount
        usd={terms.amountUsd}
        token={{ symbol: terms.token.symbol, amount: terms.amount }}
        align="end"
        className="shrink-0"
      />
    </div>
  )
}
