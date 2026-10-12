import { Button, Spinner } from '@goblin/ui'
import { formatUnits } from '@goblin/wallet/amounts'
import { DEFAULT_GRANT_DAYS } from '@goblin/wallet/contract'
import { UPGRADE_FEE_CEILINGS } from '@goblin/wallet/userop'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import { useMe } from '../api/queries.tsx'
import { type OwnerChain, useAuth } from '../app/auth.tsx'
import { cn, formatUsd, timeUntil } from '../ui/index.ts'
import { CHAIN_LABEL } from '../ui/format.ts'
import { Fold } from '../ui/fold.tsx'
import { RowList } from '../ui/page.tsx'
import { type NetworkState, networkState, OTHER_CHAINS, showsOtherNetworks } from './networks.ts'
import { ActionError, DEFAULT_PER_HOUR, isPerHour, PerHourField, useAction } from './setup-actions.tsx'

/** Runs one chain's signing while the other rows wait: Privy shows one signature at a time. */
type Hold = (chain: OwnerChain, run: () => Promise<void>) => Promise<void>

const DOT: Record<NetworkState['kind'], string> = {
  not_upgraded: 'bg-muted-foreground/50',
  upgraded: 'bg-live',
  active: 'bg-success',
  expired: 'bg-attention',
}

const stateText = (state: NetworkState): string => {
  if (state.kind === 'not_upgraded') return 'Not upgraded'
  if (state.kind === 'upgraded') return 'Upgraded, no allowance yet'
  if (state.kind === 'active')
    return `Allowance ${formatUsd(state.perHour)} an hour, ends ${timeUntil(state.expiresAt)}`
  return `Allowance of ${formatUsd(state.perHour)} an hour has ended`
}

function StateLine({ state }: { readonly state: NetworkState }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
      <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', DOT[state.kind])} />
      {stateText(state)}
    </span>
  )
}

function AllowanceForm({
  chain,
  locked,
  hold,
  onClose,
}: {
  readonly chain: OwnerChain
  readonly locked: boolean
  readonly hold: Hold
  readonly onClose: () => void
}) {
  const auth = useAuth()
  const client = useQueryClient()
  const [perHour, setPerHour] = useState(DEFAULT_PER_HOUR)
  const valid = isPerHour(perHour)
  const action = useAction(() =>
    hold(chain, async () => {
      await auth.signAllowance({ chain, perHour, days: DEFAULT_GRANT_DAYS })
      await Promise.all(['me', 'limits', 'status'].map((key) => client.invalidateQueries({ queryKey: [key] })))
      onClose()
    }),
  )
  return (
    <div className="flex flex-col gap-3">
      <PerHourField id={`per-hour-${chain}`} value={perHour} chainName={CHAIN_LABEL[chain]} onChange={setPerHour} />
      <p className="text-xs/relaxed text-muted-foreground text-pretty">
        For {DEFAULT_GRANT_DAYS} days. The chain enforces it, and you can revoke it at any time.
      </p>
      <ActionError message={action.error} />
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!valid || locked || action.pending}
          onClick={() => void action.start()}
        >
          {action.pending && <Spinner data-icon="inline-start" />}
          Sign allowance
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={action.pending} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function useUpgrade(chain: OwnerChain, hold: Hold) {
  const auth = useAuth()
  const client = useQueryClient()
  const [submitted, setSubmitted] = useState(false)
  const action = useAction(() =>
    hold(chain, async () => {
      setSubmitted(false)
      const outcome = await auth.upgrade(chain)
      setSubmitted(outcome === 'submitted')
      await Promise.all(['me', 'activity'].map((key) => client.invalidateQueries({ queryKey: [key] })))
    }),
  )
  return { ...action, submitted }
}

function NetworkRow({
  chain,
  state,
  locked,
  hold,
}: {
  readonly chain: OwnerChain
  readonly state: NetworkState
  readonly locked: boolean
  readonly hold: Hold
}) {
  const upgrade = useUpgrade(chain, hold)
  const [granting, setGranting] = useState(false)
  const needsAllowance = state.kind === 'upgraded' || state.kind === 'expired'
  const name = CHAIN_LABEL[chain]
  return (
    <li className="flex flex-col gap-3 py-3">
      <div className="flex min-h-10 items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-sm font-medium">{name}</span>
          <StateLine state={state} />
        </div>
        {state.kind === 'not_upgraded' && (
          <Button
            type="button"
            size="sm"
            disabled={locked || upgrade.pending}
            onClick={() => void upgrade.start()}
            className="shrink-0"
          >
            {upgrade.pending && <Spinner data-icon="inline-start" />}
            {upgrade.submitted ? 'Check again' : 'Upgrade'}
            <span className="sr-only"> on {name}</span>
          </Button>
        )}
        {needsAllowance && !granting && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={locked}
            onClick={() => setGranting(true)}
            className="shrink-0"
          >
            Set allowance
            <span className="sr-only"> on {name}</span>
          </Button>
        )}
      </div>
      {state.kind === 'not_upgraded' && upgrade.submitted && (
        <p className="text-xs/relaxed text-muted-foreground text-pretty">
          Sent. {name} has not confirmed it yet; check again in a minute. Checking asks you to sign again.
        </p>
      )}
      {state.kind === 'not_upgraded' && chain === 'ethereum' && (
        <p className="text-xs/relaxed text-muted-foreground text-pretty">
          Ethereum upgrades cost more: up to {formatUsd(formatUnits(UPGRADE_FEE_CEILINGS.ethereum, 6))} of gas, paid in
          USDC from your account on Ethereum.
        </p>
      )}
      {state.kind === 'not_upgraded' && <ActionError message={upgrade.error} />}
      {needsAllowance && granting && (
        <AllowanceForm chain={chain} locked={locked} hold={hold} onClose={() => setGranting(false)} />
      )}
    </li>
  )
}

/**
 * Arbitrum and Ethereum after onboarding on Base: per chain, the owner upgrades the account (its gas paid in USDC from
 * the account there) and then signs an allowance, with the same per-hour input as onboarding. Shown once Base is
 * upgraded and has an allowance.
 */
export function OtherNetworks() {
  const me = useMe()
  const [busy, setBusy] = useState<OwnerChain>()
  const hold = useCallback<Hold>(async (chain, run) => {
    setBusy(chain)
    try {
      await run()
    } finally {
      setBusy(undefined)
    }
  }, [])
  const data = me.data
  if (data === undefined || !showsOtherNetworks(data)) return null
  const active = OTHER_CHAINS.filter((chain) => networkState(data, chain).kind === 'active')
  return (
    <Fold
      id="networks"
      title="Other networks"
      summary={active.length === 0 ? 'Off' : active.map((chain) => CHAIN_LABEL[chain]).join(', ')}
    >
      <p className="px-1 text-sm/relaxed text-muted-foreground text-pretty">
        Let your agent spend on Arbitrum and Ethereum too. On each, you upgrade your account once, then set an
        allowance. The upgrade&apos;s one-time fee is paid in USDC on that network, so add some there first.
      </p>
      <RowList>
        <ul className="divide-y divide-border">
          {OTHER_CHAINS.map((chain) => (
            <NetworkRow
              key={chain}
              chain={chain}
              state={networkState(data, chain)}
              locked={busy !== undefined && busy !== chain}
              hold={hold}
            />
          ))}
        </ul>
      </RowList>
    </Fold>
  )
}
