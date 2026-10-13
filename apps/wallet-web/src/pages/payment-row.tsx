// A payment a merchant collected from one of the owner's subscriptions, as Activity and Home's Recent list it beside
// the agent's operations: what it paid for, when, how much, and the transaction on the explorer.
import { GoblinMark } from '@goblin/ui'
import type { SubscriptionPayment } from '@goblin/wallet/contract'
import { ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'
import { formatUsd } from '../ui/format.ts'
import { StatusPill } from '../ui/status-pill.tsx'
import { paymentTitle } from './subscription-model.ts'

const ROW = '-mx-4 flex min-h-16 w-[calc(100%+2rem)] items-center gap-3 px-4 py-3 text-start'
const PRESSABLE =
  'transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring active:bg-muted/60 pointer-fine:hover:bg-muted/40'

/** The row's outside: a link to the transaction once it has one, a plain row before. */
function Frame({ href, children }: { readonly href: string | undefined; readonly children: ReactNode }) {
  if (href === undefined) return <div className={ROW}>{children}</div>
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`${ROW} ${PRESSABLE}`}>
      {children}
    </a>
  )
}

export function PaymentRow({ payment, time }: { readonly payment: SubscriptionPayment; readonly time: string }) {
  const linked = payment.explorerUrl !== undefined
  return (
    <Frame href={payment.explorerUrl}>
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        <GoblinMark className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-sm font-medium">
          {paymentTitle(payment)}
          <span className="sr-only">, subscription payment</span>
        </span>
        <span className="flex min-w-0 items-center text-xs text-muted-foreground">
          <StatusPill status="confirmed" className="shrink-0" />
          <span className="truncate">, {time}</span>
          {linked && (
            <>
              <ExternalLink aria-hidden className="ms-1 size-3 shrink-0" />
              <span className="sr-only">, opens the transaction</span>
            </>
          )}
        </span>
      </span>
      <span className="shrink-0 self-start pt-px text-sm font-medium tabular-nums">{formatUsd(payment.amountUsd)}</span>
    </Frame>
  )
}
