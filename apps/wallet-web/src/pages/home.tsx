// Home, as a phone wallet opens: the balance, what the agent can spend now, three actions, then what needs the owner,
// the latest activity and the connected agents. Until setup is finished, one card on top says the next step.
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, Skeleton } from '@goblin/ui'
import type { ChainSetup, Me, Operation, OperationCheck, WalletStatusResult } from '@goblin/wallet/contract'
import type { UseQueryResult } from '@tanstack/react-query'
import { Bot, ChevronDown, Gauge, History, Plus } from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'
import { useActivity, useCheckOperation, useConnections, useMe, useStatus } from '../api/queries.tsx'
import { Link } from '../app/router.tsx'
import { ActivityRow } from '../ui/activity-row.tsx'
import { Async } from '../ui/async.tsx'
import { CHAIN_LABEL, formatUsdCompact } from '../ui/format.ts'
import { cn } from '../ui/index.ts'
import { EmptyState, RowList, Section } from '../ui/page.tsx'
import { usdOf } from '../views/money.ts'
import { type Attention, attentionOf } from '../views/overview-model.ts'
import { reviewOf } from './activity.tsx'
import { rowTime } from './activity-model.ts'
import { lastUsedOf } from './agents-model.ts'
import {
  type Holding,
  holdingsOf,
  type SetupStep,
  setupStepOf,
  type SpendLine,
  spendLineOf,
  type Total,
  totalOf,
  whereOf,
} from './home-model.ts'
import { fundedOnBase, isSetUp, setupProgress } from './progress.ts'
import { Subscriptions } from './subscriptions.tsx'

const QUIET_LINK =
  'rounded-sm text-sm text-muted-foreground underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring pointer-fine:hover:text-foreground'

const RECENT = 5

/** "$84" and ".21": the dollars carry the figure, the cents sit smaller beside them. */
function Figure({ total }: { readonly total: Total }) {
  if (!total.known)
    return (
      <span className="text-5xl leading-none font-semibold tracking-tight text-muted-foreground" aria-label="Not read">
        —
      </span>
    )
  const text = formatUsdCompact(total.usd)
  const dot = text.lastIndexOf('.')
  return (
    <span className="flex items-baseline leading-none font-semibold tracking-tight tabular-nums" aria-label={text}>
      <span aria-hidden className="text-5xl">
        {text.slice(0, dot)}
      </span>
      <span aria-hidden className="text-3xl">
        {text.slice(dot)}
      </span>
    </span>
  )
}

const usd = (micros: bigint): string => formatUsdCompact(usdOf(micros))

/** One network's coin: the total, and the owner's and the agent's parts under it. */
function HoldingRow({ holding }: { readonly holding: Holding }) {
  return (
    <li className="flex items-start justify-between gap-4 py-3">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium">
          {holding.symbol} on {CHAIN_LABEL[holding.chain]}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          Your account {usd(holding.owner)}, agent wallet {usd(holding.agent)}
        </span>
      </span>
      <span className="shrink-0 text-sm font-medium tabular-nums">{usd(holding.owner + holding.agent)}</span>
    </li>
  )
}

/** Where the money is, in a line that opens into each network's split between the owner and the agent. */
function Where({ status }: { readonly status: WalletStatusResult }) {
  const holdings = holdingsOf(status)
  const where = whereOf(holdings)
  if (where === undefined) return <p className="text-sm text-muted-foreground">Nothing in your wallet yet</p>
  return (
    <Collapsible className="flex w-full flex-col items-center">
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className="group/where -my-2 inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring active:text-foreground pointer-fine:hover:text-foreground"
          />
        }
      >
        {where}
        <ChevronDown
          aria-hidden
          className="size-3.5 group-data-panel-open/where:rotate-180 motion-safe:transition-transform"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="w-full">
        <RowList className="mt-3 text-start">
          <ul className="divide-y divide-border">
            {holdings.map((holding) => (
              <HoldingRow key={`${holding.chain}-${holding.symbol}`} holding={holding} />
            ))}
          </ul>
        </RowList>
      </CollapsibleContent>
    </Collapsible>
  )
}

function Spend({ line }: { readonly line: SpendLine }) {
  return (
    <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm text-pretty">
      <span
        aria-hidden
        className={cn('size-1.5 shrink-0 rounded-full', line.tone === 'ok' ? 'bg-success' : 'bg-attention')}
      />
      {line.tone === 'ok' ? (
        <span>
          Your agent can spend <span className="font-medium tabular-nums">{line.amount}</span> {line.within}
        </span>
      ) : (
        <span>{line.text}</span>
      )}
      {line.tone === 'blocked' && line.next !== undefined && line.next.to !== '/add-funds' && (
        <Link to={line.next.to} className={cn(QUIET_LINK, 'text-foreground underline')}>
          {line.next.label}
        </Link>
      )}
    </p>
  )
}

/** The balance at the top of Home. Loading shows a placeholder the size of the figure, so nothing moves when it lands. */
function Hero({
  status,
  setups,
  ready,
}: {
  readonly status: UseQueryResult<WalletStatusResult | undefined>
  readonly setups: readonly ChainSetup[] | undefined
  /** Setup is finished: until then the setup card says what the agent still needs, not this line. */
  readonly ready: boolean
}) {
  const data = status.data
  const total = totalOf(data)
  return (
    <section aria-labelledby="balance" className="flex flex-col items-center gap-3 pt-2 text-center">
      <h2 id="balance" className="text-sm text-muted-foreground">
        Balance
      </h2>
      {status.isPending ? <Skeleton className="h-12 w-40" /> : <Figure total={total} />}
      {data !== undefined && <Where status={data} />}
      {total.known && total.partial && (
        <p className="text-xs text-muted-foreground">Some networks could not be read, so it may be more.</p>
      )}
      {status.isError || (!status.isPending && !total.known) ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          Your balance could not be read just now.
          <Button type="button" variant="ghost" size="sm" onClick={() => void status.refetch()}>
            Try again
          </Button>
        </p>
      ) : null}
      {ready && data !== undefined && <Spend line={spendLineOf(data, setups)} />}
    </section>
  )
}

interface Action {
  readonly to: string
  readonly label: string
  readonly icon: ComponentType<SVGProps<SVGSVGElement>>
}

const ACTIONS: readonly Action[] = [
  { to: '/add-funds', label: 'Add funds', icon: Plus },
  { to: '/activity', label: 'Activity', icon: History },
  { to: '/limits', label: 'Limits', icon: Gauge },
]

/** Round actions under the balance, as a wallet app has them; Add funds leads. */
function Actions() {
  return (
    <nav aria-label="Actions" className="flex justify-center gap-6">
      {ACTIONS.map(({ to, label, icon: Icon }, index) => (
        <Link
          key={to}
          to={to}
          className="group/action flex w-20 flex-col items-center gap-2 rounded-xl py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <span
            className={cn(
              'flex size-13 items-center justify-center rounded-full transition duration-150 group-active/action:scale-[0.96]',
              index === 0
                ? 'bg-primary text-primary-foreground pointer-fine:group-hover/action:bg-primary/85'
                : 'bg-secondary text-secondary-foreground ring-1 ring-foreground/5 pointer-fine:group-hover/action:bg-muted',
            )}
          >
            <Icon aria-hidden className="size-5" strokeWidth={2} />
          </span>
          {label}
        </Link>
      ))}
    </nav>
  )
}

/**
 * What waits on the owner, above the rest: an approval with Review, a payment not confirmed with Check status (which
 * asks the chain and never pays). Each row opens to say more, as in Activity.
 */
function NeedsYou({
  items,
  onCheck,
}: {
  readonly items: readonly Attention[]
  readonly onCheck: (operation: Operation) => Promise<OperationCheck>
}) {
  return (
    <Section title="Needs you">
      <div className="flex flex-col divide-y divide-border overflow-clip rounded-xl bg-card px-4 text-card-foreground ring-1 ring-attention/50">
        {items.map(({ operation }) => (
          <ActivityRow
            key={operation.id}
            operation={operation}
            time={rowTime(operation.createdAt, { dated: true })}
            onCheck={onCheck}
            {...reviewOf(operation)}
          />
        ))}
      </div>
    </Section>
  )
}

/** The latest few operations, without the ones already waiting above. */
function Recent({
  activity,
  shown,
}: {
  readonly activity: UseQueryResult<readonly Operation[]>
  readonly shown: ReadonlySet<string>
}) {
  return (
    <Section
      title="Recent"
      action={
        <Link to="/activity" className={QUIET_LINK}>
          See all
        </Link>
      }
    >
      <Async query={activity} rows={3}>
        {(rows) => {
          const recent = rows.filter((operation) => !shown.has(operation.id)).slice(0, RECENT)
          return recent.length === 0 ? (
            <EmptyState title="Nothing spent yet" description="When your agent pays for something, it shows up here." />
          ) : (
            <RowList className="overflow-clip">
              {recent.map((operation) => (
                <ActivityRow
                  key={operation.id}
                  operation={operation}
                  time={rowTime(operation.createdAt, { dated: true })}
                />
              ))}
            </RowList>
          )
        }}
      </Async>
    </Section>
  )
}

/** Who can use the wallet, or one step to connect the first agent. */
function Agents() {
  const connections = useConnections()
  return (
    <Section
      title="Agents"
      action={
        <Link to="/connections" className={QUIET_LINK}>
          Manage
        </Link>
      }
    >
      <Async query={connections} rows={1}>
        {(rows) =>
          rows.length === 0 ? (
            <div className="flex items-center gap-3 rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10">
              <span
                aria-hidden
                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
              >
                <Bot className="size-4" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium">No agent connected</span>
                <span className="text-xs text-muted-foreground">Connect goblin or any MCP client.</span>
              </span>
              <Button size="sm" nativeButton={false} render={<Link to="/connections" />}>
                Connect
              </Button>
            </div>
          ) : (
            <RowList>
              <ul className="divide-y divide-border">
                {rows.map((connection) => (
                  <li key={connection.id} className="flex min-h-14 items-center gap-3 py-2.5">
                    <span
                      aria-hidden
                      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium uppercase"
                    >
                      {connection.client.slice(0, 1)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{connection.client}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{lastUsedOf(connection)}</span>
                  </li>
                ))}
              </ul>
            </RowList>
          )
        }
      </Async>
    </Section>
  )
}

/** A segment per setup step: the ones done filled, the rest empty. */
function StepBar({ step }: { readonly step: SetupStep }) {
  return (
    <span aria-hidden className="grid grid-cols-4 gap-1.5">
      {Array.from({ length: step.of }, (_, index) => (
        <span key={index} className={cn('h-1 rounded-full', index < step.number - 1 ? 'bg-primary' : 'bg-muted')} />
      ))}
    </span>
  )
}

/** The one card an owner who has not finished setup sees first: the next step in a line, and Continue. */
function SetupCard({ me, status }: { readonly me: Me; readonly status: WalletStatusResult | undefined }) {
  const progress = setupProgress(me, { funded: fundedOnBase(status) })
  if (progress === 'done') return null
  const step = setupStepOf(progress)
  return (
    <section
      aria-labelledby="setup"
      className="flex flex-col gap-4 rounded-2xl bg-card p-5 text-card-foreground ring-1 ring-foreground/10"
    >
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground tabular-nums">
          Step {step.number} of {step.of}
        </span>
        <h2 id="setup" className="text-base font-semibold tracking-tight text-balance">
          Finish setting up your wallet
        </h2>
        <p className="text-sm text-muted-foreground text-pretty">{step.text}</p>
      </div>
      <StepBar step={step} />
      <Button size="cta" nativeButton={false} render={<Link to="/setup" />}>
        Continue
      </Button>
    </section>
  )
}

export function HomePage() {
  const me = useMe()
  const status = useStatus()
  const activity = useActivity()
  const check = useCheckOperation()
  const attention = activity.data === undefined ? [] : attentionOf(activity.data)
  const ready = me.data === undefined || isSetUp(me.data)
  return (
    <div className="flex flex-col gap-8">
      <h1 className="sr-only">Home</h1>
      {me.data !== undefined && !ready && <SetupCard me={me.data} status={status.data} />}
      <div className="flex flex-col gap-7">
        <Hero status={status} setups={me.data?.chains} ready={ready} />
        <Actions />
      </div>
      {attention.length > 0 && <NeedsYou items={attention} onCheck={(operation) => check.mutateAsync(operation.id)} />}
      <Subscriptions />
      <Recent activity={activity} shown={new Set(attention.map((item) => item.operation.id))} />
      <Agents />
    </div>
  )
}
