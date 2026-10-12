// The dashboard: what the agent can spend now, where the money sits, which layer holds each limit, what happened
// last. Pure of the host: it renders what it is given and calls back for the two things only the host can do.
import type { ChainBalance, Operation, WalletStatusResult } from '@goblin/wallet/contract'
import { Button, Spinner } from '@goblin/ui'
import { Maximize2, Minimize2, RefreshCw } from 'lucide-react'
import {
  AddressChip,
  Amount,
  ChainBadge,
  cn,
  formatUsd,
  LimitMeter,
  ReceiptRow,
  timeAgo,
  timeUntil,
} from '../ui/index.ts'
import { EmptyState, RowList, Section } from '../ui/page.tsx'
import { sumUsd } from './money.ts'

const HOLDER = { owner: 'Your account', agent: 'Agent wallet' } as const
const LAYER_ORDER = ['onchain', 'tempo', 'signer', 'ledger', 'client'] as const
const PERIOD_ORDER = ['call', 'hour', 'day', 'week', 'total'] as const

type Readiness = WalletStatusResult['status']['paid']

const READINESS: Record<'paid' | 'funding', Record<Readiness, { label: string; dot: string }>> = {
  paid: {
    ready: { label: 'Payments ready', dot: 'bg-success' },
    blocked: { label: 'Payments blocked', dot: 'bg-attention' },
    not_verified: { label: 'Payments not verified', dot: 'bg-muted-foreground/50' },
  },
  funding: {
    ready: { label: 'Funded', dot: 'bg-success' },
    blocked: { label: 'Needs funding', dot: 'bg-attention' },
    not_verified: { label: 'Funding not verified', dot: 'bg-muted-foreground/50' },
  },
}

function Readiness({ kind, value }: { readonly kind: 'paid' | 'funding'; readonly value: Readiness }) {
  const { label, dot } = READINESS[kind][value]
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span aria-hidden className={cn('size-1.5 rounded-full', dot)} />
      {label}
    </span>
  )
}

/** The figure the whole view exists for: what the agent may spend right now under every layer's limit. */
function Spendable({ status }: { readonly status: WalletStatusResult }) {
  const token = status.status.tokens[0]
  const held = sumUsd(status.balances)
  const chains = new Set(status.balances.map((row) => row.chain)).size
  const { periodEndsAt, expiresAt } = status.status
  return (
    <section aria-label="Spendable now" className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <span className="text-sm text-muted-foreground">Your agent can spend now</span>
        <Amount usd={token?.spendable ?? '0'} size="hero" />
      </div>
      <p className="text-sm/relaxed text-muted-foreground tabular-nums">
        {formatUsd(held)} held across {chains} {chains === 1 ? 'chain' : 'chains'}
        {periodEndsAt !== undefined && <>, the hourly limit resets {timeUntil(periodEndsAt)}</>}
        {expiresAt !== undefined && <>. Access ends {timeUntil(expiresAt)}</>}.
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <Readiness kind="paid" value={status.status.paid} />
        <Readiness kind="funding" value={status.status.funding} />
      </div>
    </section>
  )
}

function Balances({ balances }: { readonly balances: readonly ChainBalance[] }) {
  if (balances.length === 0) {
    return <EmptyState title="No balances yet" description="Fund the agent wallet and it shows up here." />
  }
  return (
    <RowList>
      {balances.map((row) => (
        <div key={`${row.chain}-${row.holder}-${row.symbol}`} className="flex items-center justify-between gap-3 py-3">
          <span className="flex min-w-0 flex-col gap-1">
            <span className="text-sm font-medium">{HOLDER[row.holder]}</span>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <ChainBadge chain={row.chain} />
              <AddressChip address={row.address} chain={row.chain} />
            </span>
          </span>
          <Amount
            usd={row.balance}
            token={{ symbol: row.symbol, amount: row.balance }}
            align="end"
            className="shrink-0"
          />
        </div>
      ))}
    </RowList>
  )
}

function Header({
  checkedAt,
  refreshing,
  refreshError,
  fullscreen,
  canFullscreen,
  onRefresh,
  onToggleFullscreen,
}: {
  readonly checkedAt: string
  readonly refreshing: boolean
  readonly refreshError: string | undefined
  readonly fullscreen: boolean
  readonly canFullscreen: boolean
  readonly onRefresh: () => void
  readonly onToggleFullscreen: () => void
}) {
  return (
    <header className="flex items-center justify-between gap-3">
      <h1 className="text-base font-semibold tracking-tight">Wallet</h1>
      <div className="flex items-center gap-1">
        <span className="me-1 text-xs text-muted-foreground tabular-nums" aria-live="polite">
          {refreshError ?? `Updated ${timeAgo(checkedAt)}`}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Refresh"
          disabled={refreshing}
          onClick={onRefresh}
        >
          {refreshing ? <Spinner /> : <RefreshCw aria-hidden />}
        </Button>
        {canFullscreen && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
            onClick={onToggleFullscreen}
          >
            {fullscreen ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
          </Button>
        )}
      </div>
    </header>
  )
}

const limitOrder = (a: WalletStatusResult['limits'][number], b: WalletStatusResult['limits'][number]): number =>
  LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer) ||
  PERIOD_ORDER.indexOf(a.period) - PERIOD_ORDER.indexOf(b.period)

export function Dashboard({
  status,
  recent,
  refreshing,
  refreshError,
  displayMode,
  canFullscreen,
  onRefresh,
  onToggleFullscreen,
}: {
  readonly status: WalletStatusResult
  readonly recent: readonly Operation[]
  readonly refreshing: boolean
  readonly refreshError: string | undefined
  readonly displayMode: 'inline' | 'fullscreen' | 'pip'
  readonly canFullscreen: boolean
  readonly onRefresh: () => void
  readonly onToggleFullscreen: () => void
}) {
  const limits = status.limits.toSorted(limitOrder)
  return (
    <>
      <Header
        checkedAt={status.checkedAt}
        refreshing={refreshing}
        refreshError={refreshError}
        fullscreen={displayMode === 'fullscreen'}
        canFullscreen={canFullscreen}
        onRefresh={onRefresh}
        onToggleFullscreen={onToggleFullscreen}
      />
      <Spendable status={status} />
      <Section title="Balances">
        <Balances balances={status.balances} />
      </Section>
      <Section title="Limits">
        {limits.length === 0 ? (
          <EmptyState title="No limits set" description="Set limits in the wallet before your agent can spend." />
        ) : (
          <RowList className="gap-0 divide-y py-1">
            {limits.map((limit) => (
              <LimitMeter key={`${limit.layer}-${limit.period}-${limit.chain ?? ''}`} limit={limit} className="py-4" />
            ))}
          </RowList>
        )}
      </Section>
      <Section title="Recent">
        {recent.length === 0 ? (
          <EmptyState title="Nothing spent yet" description="When your agent pays for something it shows up here." />
        ) : (
          <RowList>
            {recent.map((operation) => (
              <ReceiptRow key={operation.id} operation={operation} />
            ))}
          </RowList>
        )}
      </Section>
    </>
  )
}
