import { cn } from './cn.ts'
import type { OperationStatus } from '@goblin/wallet/contract'

type Tone = 'live' | 'success' | 'attention' | 'destructive' | 'quiet'

const STATUS: Record<OperationStatus, { readonly label: string; readonly tone: Tone }> = {
  quoted: { label: 'Quoted', tone: 'quiet' },
  awaiting_approval: { label: 'Needs your approval', tone: 'attention' },
  reserved: { label: 'Reserved', tone: 'live' },
  signing: { label: 'Signing', tone: 'live' },
  submitted: { label: 'Submitted', tone: 'live' },
  confirmed: { label: 'Paid', tone: 'success' },
  delivered: { label: 'Delivered', tone: 'success' },
  failed: { label: 'Failed', tone: 'destructive' },
  uncertain: { label: 'Not confirmed', tone: 'attention' },
  expired: { label: 'Expired', tone: 'quiet' },
  declined: { label: 'Declined', tone: 'quiet' },
  cancelled: { label: 'Cancelled', tone: 'quiet' },
}

const DOT: Record<Tone, string> = {
  live: 'bg-live',
  success: 'bg-success',
  attention: 'bg-attention',
  destructive: 'bg-destructive',
  quiet: 'bg-muted-foreground/50',
}

const TEXT: Record<Tone, string> = {
  live: 'text-foreground',
  success: 'text-foreground',
  attention: 'text-foreground',
  destructive: 'text-destructive',
  quiet: 'text-muted-foreground',
}

/** An operation's state: a coloured dot and a plain-words label. `uncertain` and `awaiting_approval` read as amber. */
export function StatusPill({ status, className }: { readonly status: OperationStatus; readonly className?: string }) {
  const { label, tone } = STATUS[status]
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap', TEXT[tone], className)}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', DOT[tone])} />
      {label}
    </span>
  )
}

export const statusLabel = (status: OperationStatus): string => STATUS[status].label
