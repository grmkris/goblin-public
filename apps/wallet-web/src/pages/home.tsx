// Home: the same overview as the dashboard App, with the owner's actions beside it: approve what waits, fund the
// account, set an allowance on another network.
import { Button } from '@goblin/ui'
import type { ChainSetup, Operation, WalletStatusResult } from '@goblin/wallet/contract'
import type { UseQueryResult } from '@tanstack/react-query'
import { useActivity, useConnections, useMe, useStatus } from '../api/queries.tsx'
import { Link } from '../app/router.tsx'
import { Async } from '../ui/async.tsx'
import { EmptyState, Page, Section } from '../ui/page.tsx'
import { NEXT_LABEL } from '../views/overview-copy.ts'
import {
  type Attention,
  attentionOf,
  balanceGroups,
  boundariesOf,
  type NextAction,
  nextActionOf,
  spendingOf,
} from '../views/overview-model.ts'
import {
  AttentionList,
  BalanceGroups,
  BoundaryList,
  OverviewColumns,
  RecentWork,
  SpendingSummary,
} from '../views/overview.tsx'
import { AddFundsCard } from './add-funds.tsx'
import { OtherNetworks } from './other-networks.tsx'

const QUIET_LINK =
  'rounded-sm text-sm text-muted-foreground underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring pointer-fine:hover:underline'

/** Where each next step happens on the owner site: a page, or a section further down Home. */
const NEXT_TARGET: Record<Exclude<NextAction, 'wait'>, string> = {
  finish_setup: '/',
  renew_access: '/limits',
  refresh: '/',
  set_allowance: '#networks',
  add_funds: '#add-funds',
}

function NextStep({ action, onRefresh }: { readonly action: NextAction; readonly onRefresh: () => void }) {
  if (action === 'wait') return null
  if (action === 'refresh')
    return (
      <Button type="button" variant="outline" onClick={onRefresh}>
        {NEXT_LABEL.refresh}
      </Button>
    )
  const target = NEXT_TARGET[action]
  return target.startsWith('#') ? (
    <Button nativeButton={false} render={<a href={target} />}>
      {NEXT_LABEL[action]}
    </Button>
  ) : (
    <Button nativeButton={false} render={<Link to={target} />}>
      {NEXT_LABEL[action]}
    </Button>
  )
}

function attentionAction(item: Attention) {
  return item.kind === 'approval' ? (
    <Button size="sm" nativeButton={false} render={<Link to={`/approve/${item.operation.id}`} />}>
      Review
    </Button>
  ) : (
    <Link to="/activity" className={QUIET_LINK}>
      Check in Activity
    </Link>
  )
}

/** Connecting never gated setup, so Home says when no agent is connected yet and where to do it. */
function ConnectNudge() {
  const connections = useConnections()
  if (connections.data === undefined || connections.data.length > 0) return null
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl bg-card px-4 py-3 text-card-foreground ring-1 ring-foreground/10">
      <span className="text-sm">No agent is connected yet.</span>
      <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/connections" />}>
        Connect your agent
      </Button>
    </div>
  )
}

function Overview({
  status,
  setups,
  activity,
  onRefresh,
}: {
  readonly status: WalletStatusResult
  readonly setups: readonly ChainSetup[] | undefined
  readonly activity: UseQueryResult<readonly Operation[]>
  readonly onRefresh: () => void
}) {
  const spending = spendingOf(status, setups === undefined ? {} : { setups })
  const next = spending.blocker === undefined ? undefined : nextActionOf(spending.blocker)
  return (
    <>
      <SpendingSummary
        spending={spending}
        action={next === undefined || next === 'wait' ? undefined : <NextStep action={next} onRefresh={onRefresh} />}
      />
      <OverviewColumns>
        <Async query={activity} rows={3}>
          {(rows) => (
            <RecentWork
              operations={rows}
              action={
                <Link to="/activity" className={QUIET_LINK}>
                  See all
                </Link>
              }
            />
          )}
        </Async>
        <BoundaryList
          boundaries={boundariesOf(spending, status.limits)}
          chain={spending.spend.chain}
          expiresAt={status.status.expiresAt}
          action={
            <Link to="/limits" className={QUIET_LINK}>
              All limits
            </Link>
          }
        />
      </OverviewColumns>
      <Section title="Balances">
        <BalanceGroups groups={balanceGroups(status)} />
      </Section>
    </>
  )
}

export function HomePage() {
  const status = useStatus()
  const activity = useActivity()
  const me = useMe()
  return (
    <Page title="Home" description="What your agent can spend, what needs you, and what it did.">
      {activity.data !== undefined && <AttentionList items={attentionOf(activity.data)} actionFor={attentionAction} />}
      <ConnectNudge />
      <Async query={status} rows={3}>
        {(data) =>
          data === undefined ? (
            <EmptyState title="Balances are not available yet" description="Your activity and limits are still live." />
          ) : (
            <Overview
              status={data}
              setups={me.data?.chains}
              activity={activity}
              onRefresh={() => void status.refetch()}
            />
          )
        }
      </Async>
      {me.data !== undefined && (
        <Section id="add-funds" title="Add funds">
          <AddFundsCard owner={me.data.owner} />
        </Section>
      )}
      <OtherNetworks />
    </Page>
  )
}
