// The overview's sections, shared by the dashboard App and the owner's Home. Each renders what the display model says;
// the caller adds only what it alone can do: links and owner actions on Home, the host's refresh in the App.
import { Badge, Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from '@goblin/ui'
import type { ChainKey, Operation } from '@goblin/wallet/contract'
import { ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'
import { AddressChip, Amount, cn, formatUsd, LAYERS, PERIOD_LABEL, ReceiptRow, timeUntil } from '../ui/index.ts'
import { CHAIN_LABEL, formatUsdCompact } from '../ui/format.ts'
import { EmptyState, RowList, Section } from '../ui/page.tsx'
import { usdOf } from './money.ts'
import { assetOn, blockerText, constraintText, limitValue } from './overview-copy.ts'
import type { AssetRow, Attention, Boundary, Holding, NetworkBalances, Spending } from './overview-model.ts'

function AvailableFigure({ spending }: { readonly spending: Spending }) {
  const { available } = spending
  if (!available.known)
    return <span className="text-4xl leading-none font-semibold tracking-tight text-muted-foreground">Unknown</span>
  const usd = usdOf(available.micros)
  return (
    <span className="flex flex-col gap-1">
      <Amount usd={usd} size="hero" compact />
      {formatUsdCompact(usd) !== formatUsd(usd) && (
        <span className="text-xs text-muted-foreground tabular-nums">Exactly {formatUsd(usd)}</span>
      )}
    </span>
  )
}

/** What the agent can spend now, in which asset on which network, what holds it back, and the next step if blocked. */
export function SpendingSummary({ spending, action }: { readonly spending: Spending; readonly action?: ReactNode }) {
  const { blocker, constraint, others } = spending
  const sentence = blocker === undefined ? constraint && constraintText(constraint) : blockerText(blocker, spending)
  return (
    <section
      aria-label="What your agent can spend"
      className="flex flex-col gap-4 rounded-xl bg-card p-5 text-card-foreground ring-1 ring-foreground/10"
    >
      <div className="flex flex-col gap-2">
        <h2 className="text-sm text-muted-foreground">Your agent can spend now</h2>
        <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
          <AvailableFigure spending={spending} />
          <span className="pt-2 text-base font-medium text-muted-foreground">{assetOn(spending)}</span>
        </div>
      </div>
      {sentence !== undefined && (
        <p className={cn('max-w-prose text-sm/relaxed text-pretty', blocker === undefined && 'text-muted-foreground')}>
          {blocker !== undefined && (
            <span aria-hidden className="me-2 inline-block size-1.5 rounded-full bg-attention align-middle" />
          )}
          {sentence}
        </p>
      )}
      {others.length > 0 && (
        <p className="text-sm text-muted-foreground tabular-nums">
          Also{' '}
          {others
            .map(
              (other) =>
                `${other.available.known ? formatUsdCompact(usdOf(other.available.micros)) : ''} ${assetOn(other)}`,
            )
            .join(', ')}
          .
        </p>
      )}
      {action !== undefined && <div className="flex flex-wrap items-center gap-2">{action}</div>}
    </section>
  )
}

const ATTENTION_TITLE: Record<Attention['kind'], string> = {
  approval: 'Your agent is waiting for your approval',
  uncertain: 'Payment not confirmed',
}

/** What needs the owner, above everything else; nothing when nothing does. */
export function AttentionList({
  items,
  actionFor,
}: {
  readonly items: readonly Attention[]
  readonly actionFor?: (item: Attention) => ReactNode
}) {
  if (items.length === 0) return null
  return (
    <section
      aria-label="Needs your attention"
      className="flex flex-col divide-y divide-border rounded-xl bg-card px-4 text-card-foreground ring-1 ring-attention/60"
    >
      {items.map((item) => (
        <div key={item.operation.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
          <span className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
            <span className="flex items-center gap-2 text-sm font-medium">
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-attention" />
              {ATTENTION_TITLE[item.kind]}
            </span>
            <span className="truncate text-sm text-muted-foreground">
              {item.operation.terms.subject}, {formatUsd(item.operation.terms.amountUsd)}
            </span>
            {item.kind === 'uncertain' && (
              <span className="text-xs/relaxed text-muted-foreground text-pretty">
                Held, and never paid again on its own. Check its status to settle or release it.
              </span>
            )}
          </span>
          {actionFor?.(item)}
        </div>
      ))}
    </section>
  )
}

/** The latest operations, newest first. */
export function RecentWork({
  operations,
  count = 3,
  action,
}: {
  readonly operations: readonly Operation[]
  readonly count?: number
  readonly action?: ReactNode
}) {
  return (
    <Section title="Recent work" action={action}>
      {operations.length === 0 ? (
        <EmptyState title="Nothing spent yet" description="When your agent pays for something, it shows up here." />
      ) : (
        <RowList>
          {operations.slice(0, count).map((operation) => (
            <ReceiptRow key={operation.id} operation={operation} />
          ))}
        </RowList>
      )}
    </Section>
  )
}

/** The limits that apply on the summary's network, the one holding back the amount marked, and when access ends. */
export function BoundaryList({
  boundaries,
  chain,
  expiresAt,
  action,
}: {
  readonly boundaries: readonly Boundary[]
  readonly chain: ChainKey
  readonly expiresAt: string | undefined
  readonly action?: ReactNode
}) {
  return (
    <Section title={`Limits on ${CHAIN_LABEL[chain]}`} action={action}>
      <RowList>
        {boundaries.map(({ limit, binding }) => (
          <div
            key={`${limit.layer}-${limit.period}-${limit.chain ?? ''}`}
            className="flex items-start justify-between gap-3 py-3"
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium">{PERIOD_LABEL[limit.period]}</span>
              <span className="text-xs text-muted-foreground">{LAYERS[limit.layer].name}</span>
            </span>
            <span className="flex shrink-0 flex-col items-end gap-1 text-end">
              <span className="text-sm tabular-nums">{limitValue(limit)}</span>
              {binding ? (
                <Badge variant="secondary">Limiting now</Badge>
              ) : (
                limit.periodEndsAt !== undefined &&
                limit.period !== 'call' && (
                  <span className="text-xs text-muted-foreground">resets {timeUntil(limit.periodEndsAt)}</span>
                )
              )}
            </span>
          </div>
        ))}
        {boundaries.length === 0 && <p className="py-3 text-sm text-muted-foreground">No limits are reported here.</p>}
        {expiresAt !== undefined && (
          <div className="flex items-center justify-between gap-3 py-3">
            <span className="text-sm font-medium">Access ends</span>
            <span className="text-sm tabular-nums">{timeUntil(expiresAt)}</span>
          </div>
        )}
      </RowList>
    </Section>
  )
}

function HoldingCell({ asset, holding }: { readonly asset: AssetRow; readonly holding: Holding | undefined }) {
  if (holding === undefined) return <span className="text-muted-foreground">None</span>
  return asset.role === 'payments' ? (
    <Amount usd={holding.amount} size="sm" align="end" compact />
  ) : (
    <Amount token={{ symbol: asset.symbol, amount: holding.amount }} size="sm" align="end" compact />
  )
}

function NetworkTable({ group }: { readonly group: NetworkBalances }) {
  return (
    <RowList>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3">
        <h3 className="text-sm font-semibold">{CHAIN_LABEL[group.chain]}</h3>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {group.agentAddress !== undefined && (
            <AddressChip label="Agent" address={group.agentAddress} chain={group.chain} />
          )}
          {group.ownerAddress !== undefined && (
            <AddressChip label="You" address={group.ownerAddress} chain={group.chain} />
          )}
        </span>
      </div>
      {group.read ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th className="py-2 text-start font-normal">Asset</th>
              <th className="py-2 text-end font-normal">Agent wallet</th>
              <th className="py-2 ps-3 text-end font-normal">Your account</th>
            </tr>
          </thead>
          <tbody>
            {group.assets.map((asset) => (
              <tr key={asset.symbol} className="border-t border-border">
                <th scope="row" className="py-2.5 text-start font-medium">
                  {asset.symbol}
                  {asset.role === 'gas' && (
                    <span className="ms-1.5 text-xs font-normal text-muted-foreground">gas</span>
                  )}
                </th>
                <td className="py-2.5 text-end">
                  <HoldingCell asset={asset} holding={asset.agent} />
                </td>
                <td className="py-2.5 ps-3 text-end">
                  <HoldingCell asset={asset} holding={asset.owner} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="py-3 text-sm text-muted-foreground">Could not read balances here. They are unknown, not zero.</p>
      )}
      {group.ownerOutOfReach && (
        <p className="py-3 text-xs/relaxed text-muted-foreground text-pretty">
          Your agent has no allowance here, so it cannot draw on your account on {CHAIN_LABEL[group.chain]}.
        </p>
      )}
    </RowList>
  )
}

const listOf = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`

/** Balances by network: what is held and what could not be read stay in view, empty networks fold away. */
export function BalanceGroups({ groups }: { readonly groups: readonly NetworkBalances[] }) {
  if (groups.length === 0)
    return <EmptyState title="No balances yet" description="Once your agent has a wallet, its balances show here." />
  const shown = groups.filter((group) => !group.read || group.funded)
  const empty = groups.filter((group) => group.read && !group.funded)
  return (
    <div className="flex flex-col gap-3">
      {shown.map((group) => (
        <NetworkTable key={group.chain} group={group} />
      ))}
      {shown.length === 0 && <p className="text-sm text-muted-foreground">Nothing is held on any network yet.</p>}
      {empty.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" className="group/fold" />}>
            Nothing held on {listOf(empty.map((group) => CHAIN_LABEL[group.chain]))}
            <ChevronDown
              data-icon="inline-end"
              aria-hidden
              className="group-data-panel-open/fold:rotate-180 motion-safe:transition-transform"
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="flex flex-col gap-3 pt-3">
              {empty.map((group) => (
                <NetworkTable key={group.chain} group={group} />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}

/** Two columns where the frame is wide enough, one column in reading order where it is not. */
export function OverviewColumns({ children }: { readonly children: ReactNode }) {
  return (
    <div className="@container">
      <div className="grid gap-8 @2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] @2xl:gap-6">{children}</div>
    </div>
  )
}
