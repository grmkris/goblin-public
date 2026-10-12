// The dashboard App: the address the agent pays from (with Add funds from any chain), what it can spend now and what
// holds it back, what needs the owner, then the overview, activity and limits as tabs. Pure of the host: it renders what
// it is given and calls back for what only the host can do. Owner actions that sign (allowances, approvals) live in the
// wallet site, so here they are named.
import type { Operation, OperationCheck, WalletStatusResult } from '@goblin/wallet/contract'
import { Button, buttonVariants, Spinner, Tabs, TabsContent, TabsList, TabsTrigger } from '@goblin/ui'
import { ExternalLink, Maximize2, Minimize2, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { CheckStatus } from '../ui/check-status.tsx'
import { LimitMeter, ReceiptRow, timeAgo } from '../ui/index.ts'
import { EmptyState, RowList, Section } from '../ui/page.tsx'
import { type FundActions, PaysFrom } from './fund.tsx'
import { agentOnTempo, isEmpty, opensOnAddFunds } from './fund-model.ts'
import { NEXT_LABEL } from './overview-copy.ts'
import { SetupCard } from './setup-card.tsx'
import { setupChecklist, setupGapsOf } from './setup-model.ts'
import { attentionOf, balanceGroups, boundariesOf, limitOrder, nextActionOf, spendingOf } from './overview-model.ts'
import type { Attention, NextAction, Spending } from './overview-model.ts'
import {
  AttentionList,
  BalanceGroups,
  BoundaryList,
  OverviewColumns,
  RecentWork,
  SpendingSummary,
} from './overview.tsx'

/** What the owner does next, said in the App where the action itself lives in the wallet site. */
const IN_WALLET: Record<Exclude<NextAction, 'refresh' | 'wait' | 'add_funds'>, string> = {
  finish_setup: 'Finish setup in your wallet.',
  renew_access: 'Review your limits in your wallet.',
  set_allowance: "Set an allowance from your wallet's Home.",
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

function NextStep({
  action,
  onRefresh,
  onAddFunds,
}: {
  readonly action: Step
  readonly onRefresh: () => void
  readonly onAddFunds: () => void
}) {
  if (action === 'refresh' || action === 'add_funds')
    return (
      <Button type="button" variant="outline" onClick={action === 'refresh' ? onRefresh : onAddFunds}>
        {action === 'refresh' ? NEXT_LABEL.refresh : 'Add funds from any chain'}
      </Button>
    )
  return <p className="text-sm text-muted-foreground">{IN_WALLET[action]}</p>
}

/** Add funds starts open when the wallet is empty, and is open whenever the host asks for it or the owner opens it. */
function useAddFundsOpen(status: WalletStatusResult): readonly [boolean, () => void] {
  const [opened, setOpened] = useState(() => opensOnAddFunds(status))
  return [opened || status.focus === 'add_funds', () => setOpened(true)]
}

function LimitsTab({ status, ready }: { readonly status: WalletStatusResult; readonly ready: boolean }) {
  const limits = status.limits.toSorted(limitOrder)
  // Before setup nothing is in force: no allowance to cap, no access to end.
  if (!ready)
    return <EmptyState title="No limits yet" description="Your limits start once setup is finished in your wallet." />
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

/** Overview, activity and limits, as tabs below what the agent can spend now. */
function DashboardTabs({
  status,
  recent,
  spending,
  ready,
  onCheck,
}: {
  readonly status: WalletStatusResult
  readonly recent: readonly Operation[]
  readonly spending: Spending
  /** Setup is finished: the limits are in force and are listed. */
  readonly ready: boolean
  readonly onCheck: (operation: Operation) => Promise<OperationCheck>
}) {
  return (
    <Tabs defaultValue="overview">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="activity">Activity</TabsTrigger>
        <TabsTrigger value="limits">Limits</TabsTrigger>
      </TabsList>
      <TabsContent value="overview">
        <div className="flex flex-col gap-8">
          {ready ? (
            <OverviewColumns>
              <RecentWork operations={recent} />
              <BoundaryList
                boundaries={boundariesOf(spending, status.limits)}
                chain={spending.spend.chain}
                expiresAt={status.status.expiresAt}
              />
            </OverviewColumns>
          ) : (
            <RecentWork operations={recent} />
          )}
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
        <LimitsTab status={status} ready={ready} />
      </TabsContent>
    </Tabs>
  )
}

export function Dashboard({
  status,
  recent,
  refreshing,
  refreshError,
  refusedLink,
  onCheck,
  fund,
  fullscreen,
  onRefresh,
  onToggleFullscreen,
  setup,
  client,
}: {
  readonly status: WalletStatusResult
  /** What setup still needs, as the tool result says it; undefined when it does not. */
  readonly setup: readonly string[] | undefined
  /** The host by its own name ("goblin"), for the setup card. */
  readonly client: string | undefined
  readonly recent: readonly Operation[]
  readonly refreshing: boolean
  readonly refreshError: string | undefined
  /** The last link the host would not open, named so the owner can open it themselves. */
  readonly refusedLink: string | undefined
  readonly onCheck: (operation: Operation) => Promise<OperationCheck>
  readonly fund: FundActions
  readonly fullscreen: boolean
  readonly onRefresh: () => void
  /** Absent when the host offers no full screen. */
  readonly onToggleFullscreen: (() => void) | undefined
}) {
  const [addFundsOpen, openAddFunds] = useAddFundsOpen(status)
  // Not ready for the agent: the setup card leads instead of an amount nobody can spend yet.
  const checklist = setupChecklist(setupGapsOf(status, setup))
  const spending = spendingOf(status)
  const next = spending.blocker === undefined ? undefined : nextActionOf(spending.blocker)
  const step = next === undefined || next === 'wait' ? undefined : next
  // Where the agent pays from leads only while it is the task (empty, or opened on Add funds); otherwise what the
  // agent can spend comes first and the address follows it.
  const fundingLeads = isEmpty(status) || addFundsOpen
  const paysFrom = status.payFrom !== undefined && (
    <PaysFrom
      payFrom={status.payFrom}
      empty={isEmpty(status)}
      open={addFundsOpen}
      held={agentOnTempo(status)}
      actions={fund}
      onOpen={openAddFunds}
      automatic={status.float?.automatic === true}
    />
  )
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
      {fundingLeads && paysFrom}
      <AttentionList items={attentionOf(recent)} actionFor={attentionFor(status.site, onCheck)} />
      {checklist.length > 0 ? (
        <SetupCard client={client} checklist={checklist} site={status.site} />
      ) : (
        <SpendingSummary
          spending={spending}
          action={
            step === undefined ? undefined : <NextStep action={step} onRefresh={onRefresh} onAddFunds={openAddFunds} />
          }
        />
      )}
      {!fundingLeads && paysFrom}
      <DashboardTabs
        status={status}
        recent={recent}
        spending={spending}
        ready={checklist.length === 0}
        onCheck={onCheck}
      />
    </>
  )
}
