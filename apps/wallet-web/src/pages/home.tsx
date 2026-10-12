import { Card, CardContent } from '@goblin/ui'
import type { ChainBalance, Operation, WalletStatusResult } from '@goblin/wallet/contract'
import { ChevronRight } from 'lucide-react'
import { useActivity, useLimits, useStatus } from '../api/queries.tsx'
import { Link } from '../app/router.tsx'
import { AddressChip, Amount, ChainBadge, formatUsd, LimitMeter, ReceiptRow, timeUntil } from '../ui/index.ts'
import { Async } from '../ui/async.tsx'
import { EmptyState, Page, RowList, Section } from '../ui/page.tsx'
import { OtherNetworks } from './other-networks.tsx'

const HOLDER = { owner: 'Your account', agent: 'Agent wallet' } as const

const sumUsd = (balances: readonly ChainBalance[]): string => {
  const micros = balances.reduce((total, row) => total + Math.round(Number(row.balance) * 1_000_000), 0)
  return (micros / 1_000_000).toFixed(6).replace(/\.?0+$/u, '')
}

function PendingApproval({ operation }: { readonly operation: Operation }) {
  return (
    <Link
      to={`/approve/${operation.id}`}
      className="flex items-center justify-between gap-4 rounded-xl bg-card p-4 ring-1 ring-attention/60 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-ring active:bg-muted pointer-fine:hover:bg-muted"
    >
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-2 text-sm font-medium">
          <span aria-hidden className="size-1.5 rounded-full bg-attention" />
          Your agent is waiting for you
        </span>
        <span className="truncate text-sm text-muted-foreground">{operation.terms.subject}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <Amount usd={operation.terms.amountUsd} size="md" align="end" />
        <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
      </span>
    </Link>
  )
}

function Balance({ status }: { readonly status: WalletStatusResult }) {
  const spendable = status.status.tokens[0]?.spendable
  const chains = new Set(status.balances.map((row) => row.chain)).size
  return (
    <Card>
      <CardContent>
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <span className="text-sm text-muted-foreground">Your agent can spend now</span>
            <Amount usd={spendable ?? '0'} size="hero" />
            <span className="text-sm text-muted-foreground tabular-nums">
              of {formatUsd(sumUsd(status.balances))} across {chains} {chains === 1 ? 'chain' : 'chains'}
              {status.status.periodEndsAt !== undefined && (
                <>, the hourly limit resets {timeUntil(status.status.periodEndsAt)}</>
              )}
            </span>
          </div>
          <ul className="flex flex-col divide-y divide-border border-t border-border">
            {status.balances.map((row) => (
              <li key={`${row.chain}-${row.holder}`} className="flex items-center justify-between gap-3 py-3">
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm font-medium">{HOLDER[row.holder]}</span>
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                    <ChainBadge chain={row.chain} />
                    <AddressChip address={row.address} chain={row.chain} />
                  </span>
                </span>
                <Amount usd={row.balance} token={{ symbol: row.symbol, amount: row.balance }} size="md" align="end" />
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  )
}

export function HomePage() {
  const status = useStatus()
  const limits = useLimits()
  const activity = useActivity()
  const waiting = activity.data?.find((operation) => operation.status === 'awaiting_approval')
  return (
    <Page title="Home" description="What your agent can spend, what it has spent, and who is enforcing each limit.">
      {waiting !== undefined && <PendingApproval operation={waiting} />}
      <Async query={status} rows={2}>
        {(data) =>
          data === undefined ? (
            <EmptyState title="Balances are not available yet" description="Your limits and activity below are live." />
          ) : (
            <Balance status={data} />
          )
        }
      </Async>
      <Section
        title="Limits"
        action={
          <Link to="/limits" className="text-sm text-muted-foreground underline-offset-4 pointer-fine:hover:underline">
            Edit
          </Link>
        }
      >
        <Async query={limits} rows={2}>
          {(rows) => (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,19rem),1fr))] gap-3">
              {rows.map((limit) => (
                <Card key={`${limit.layer}-${limit.period}-${limit.chain ?? ''}`}>
                  <CardContent>
                    <LimitMeter limit={limit} />
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </Async>
      </Section>
      <Section
        title="Recent activity"
        action={
          <Link
            to="/activity"
            className="text-sm text-muted-foreground underline-offset-4 pointer-fine:hover:underline"
          >
            See all
          </Link>
        }
      >
        <Async query={activity}>
          {(rows) =>
            rows.length === 0 ? (
              <EmptyState
                title="Nothing spent yet"
                description="When your agent pays for something, it shows up here with its receipt."
              />
            ) : (
              <RowList>
                {rows.slice(0, 5).map((operation) => (
                  <ReceiptRow key={operation.id} operation={operation} />
                ))}
              </RowList>
            )
          }
        </Async>
      </Section>
      <OtherNetworks />
    </Page>
  )
}
