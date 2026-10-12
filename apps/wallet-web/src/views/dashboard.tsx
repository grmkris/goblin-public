// The dashboard App: what the agent can spend now and what holds it back, what needs the owner, then the overview,
// activity and limits as tabs. Pure of the host: it renders what it is given and calls back for the two things only
// the host can do. Owner actions (funding, allowances, approvals) live in the wallet site, so here they are named.
import type { Operation, OperationCheck, WalletStatusResult } from '@goblin/wallet/contract'
import { Button, buttonVariants, Spinner, Tabs, TabsContent, TabsList, TabsTrigger } from '@goblin/ui'
import { ExternalLink, Maximize2, Minimize2, RefreshCw } from 'lucide-react'
import { CheckStatus } from '../ui/check-status.tsx'
import { LimitMeter, ReceiptRow, timeAgo } from '../ui/index.ts'
import { EmptyState, RowList, Section } from '../ui/page.tsx'
import { NEXT_LABEL } from './overview-copy.ts'
import { attentionOf, balanceGroups, boundariesOf, limitOrder, nextActionOf, spendingOf } from './overview-model.ts'
import type { Attention, NextAction } from './overview-model.ts'
import {
  AttentionList,
  BalanceGroups,
  BoundaryList,
  OverviewColumns,
  RecentWork,
  SpendingSummary,
} from './overview.tsx'

/** What the owner does next, said in the App where the action itself lives in the wallet site. */
const IN_WALLET: Record<Exclude<NextAction, 'refresh' | 'wait'>, string> = {
  finish_setup: 'Finish setup in your wallet.',
  renew_access: 'Review your limits in your wallet.',
  set_allowance: "Set an allowance from your wallet's Home.",
  add_funds: "Add funds from your wallet's Home.",
}

function Header({
  checkedAt,
  site,
  refreshing,
  refreshError,
  fullscreen,
  onRefresh,
  onToggleFullscreen,
}: {
  readonly checkedAt: string
  readonly site: string | undefined
  readonly refreshing: boolean
  readonly refreshError: string | undefined
  readonly fullscreen: boolean
  readonly onRefresh: () => void
  readonly onToggleFullscreen: (() => void) | undefined
}) {
  return (
    <header className="flex items-center justify-between gap-3">
      <h1 className="text-base font-semibold tracking-tight">Wallet</h1>
      <div className="flex items-center gap-1">
        <span className="me-1 text-xs text-muted-foreground tabular-nums" aria-live="polite">
          {refreshError === undefined
            ? `Updated ${timeAgo(checkedAt)}`
            : `${refreshError} Showing what was read ${timeAgo(checkedAt)}.`}
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
        {site !== undefined && (
          <a
            href={site}
            aria-label="Open the wallet site"
            title="Open the wallet site"
            className={buttonVariants({ variant: 'ghost', size: 'icon' })}
          >
            <ExternalLink aria-hidden />
          </a>
        )}
        {onToggleFullscreen !== undefined && (
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

/**
 * What an item that needs the owner offers: Check status for an unknown outcome (it never pays), or a waiting spend's
 * Approve page on the wallet site, opened through the host like every link.
 */
const attentionFor =
  (site: string | undefined, onCheck: (operation: Operation) => Promise<OperationCheck>) => (item: Attention) =>
    item.kind === 'uncertain' ? (
      <CheckStatus operation={item.operation} onCheck={onCheck} />
    ) : site === undefined ? (
      <span className="text-xs text-muted-foreground">Approve it in your wallet</span>
    ) : (
      <a href={`${site}/approve/${encodeURIComponent(item.operation.id)}`} className={buttonVariants({ size: 'sm' })}>
        Review and approve
        <ExternalLink aria-hidden data-icon="inline-end" />
      </a>
    )

/** A link the host would not open, named so the owner can open it themselves. */
function RefusedLink({ link }: { readonly link: string | undefined }) {
  if (link === undefined) return null
  return (
    <p role="status" className="text-sm text-muted-foreground">
      The host did not open {new URL(link).host}. Open it yourself: {link}
    </p>
  )
}

type Step = Exclude<NextAction, 'wait'>

function NextStep({ action, onRefresh }: { readonly action: Step; readonly onRefresh: () => void }) {
  if (action === 'refresh')
    return (
      <Button type="button" variant="outline" onClick={onRefresh}>
        {NEXT_LABEL.refresh}
      </Button>
    )
  return <p className="text-sm text-muted-foreground">{IN_WALLET[action]}</p>
}

function LimitsTab({ status }: { readonly status: WalletStatusResult }) {
  const limits = status.limits.toSorted(limitOrder)
  if (limits.length === 0)
    return <EmptyState title="No limits set" description="Set limits in the wallet before your agent can spend." />
  return (
    <RowList className="gap-0 divide-y py-1">
      {limits.map((limit) => (
        <LimitMeter key={`${limit.layer}-${limit.period}-${limit.chain ?? ''}`} limit={limit} className="py-4" />
      ))}
    </RowList>
  )
}

export function Dashboard({
  status,
  recent,
  refreshing,
  refreshError,
  refusedLink,
  onCheck,
  fullscreen,
  onRefresh,
  onToggleFullscreen,
}: {
  readonly status: WalletStatusResult
  readonly recent: readonly Operation[]
  readonly refreshing: boolean
  readonly refreshError: string | undefined
  /** The last link the host would not open, named so the owner can open it themselves. */
  readonly refusedLink: string | undefined
  readonly onCheck: (operation: Operation) => Promise<OperationCheck>
  readonly fullscreen: boolean
  readonly onRefresh: () => void
  /** Absent when the host offers no full screen. */
  readonly onToggleFullscreen: (() => void) | undefined
}) {
  const spending = spendingOf(status)
  const next = spending.blocker === undefined ? undefined : nextActionOf(spending.blocker)
  const step = next === undefined || next === 'wait' ? undefined : next
  return (
    <>
      <Header
        checkedAt={status.checkedAt}
        site={status.site}
        refreshing={refreshing}
        refreshError={refreshError}
        fullscreen={fullscreen}
        onRefresh={onRefresh}
        onToggleFullscreen={onToggleFullscreen}
      />
      <RefusedLink link={refusedLink} />
      <AttentionList items={attentionOf(recent)} actionFor={attentionFor(status.site, onCheck)} />
      <SpendingSummary
        spending={spending}
        action={step === undefined ? undefined : <NextStep action={step} onRefresh={onRefresh} />}
      />
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="limits">Limits</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <div className="flex flex-col gap-8">
            <OverviewColumns>
              <RecentWork operations={recent} />
              <BoundaryList
                boundaries={boundariesOf(spending, status.limits)}
                chain={spending.spend.chain}
                expiresAt={status.status.expiresAt}
              />
            </OverviewColumns>
            <Section title="Balances">
              <BalanceGroups groups={balanceGroups(status)} />
            </Section>
          </div>
        </TabsContent>
        <TabsContent value="activity">
          {recent.length === 0 ? (
            <EmptyState title="Nothing spent yet" description="When your agent pays for something, it shows up here." />
          ) : (
            <RowList>
              {recent.map((operation) => (
                <ReceiptRow key={operation.id} operation={operation} onCheck={onCheck} />
              ))}
            </RowList>
          )}
        </TabsContent>
        <TabsContent value="limits">
          <LimitsTab status={status} />
        </TabsContent>
      </Tabs>
    </>
  )
}
