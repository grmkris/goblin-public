import { Button, Spinner } from '@goblin/ui'
import { DEFAULT_GRANT_DAYS, type Me } from '@goblin/wallet/contract'
import { useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useConnections, useCreateAgent } from '../api/queries.tsx'
import { useAuth } from '../app/auth.tsx'
import { navigate } from '../app/router.tsx'
import { cn } from '../ui/index.ts'
import { LAYERS } from '../ui/layer.tsx'
import { Page } from '../ui/page.tsx'
import { ConnectPanel } from './connect-panel.tsx'
import { type StepId, setupProgress } from './progress.ts'
import { ActionError, DEFAULT_PER_HOUR, isPerHour, PerHourField, useAction } from './setup-actions.tsx'

const SKIP_KEY = 'goblin-wallet:connect-skipped'

export const readSkipped = (): boolean => {
  try {
    return window.localStorage.getItem(SKIP_KEY) === '1'
  } catch {
    // expected: storage can be blocked; the step then simply stays visible
    return false
  }
}

function Step({
  index,
  state,
  title,
  summary,
  children,
}: {
  readonly index: number
  readonly state: 'done' | 'current' | 'upcoming'
  readonly title: string
  readonly summary?: string
  readonly children?: ReactNode
}) {
  return (
    <li
      aria-current={state === 'current' ? 'step' : undefined}
      className="grid grid-cols-[2rem_1fr] gap-x-3 gap-y-3 pb-6 last:pb-0"
    >
      <span
        aria-hidden
        className={cn(
          'flex size-8 items-center justify-center rounded-full text-sm font-medium tabular-nums',
          state === 'done' && 'bg-moss text-moss-foreground',
          state === 'current' && 'bg-foreground text-background',
          state === 'upcoming' && 'bg-muted text-muted-foreground',
        )}
      >
        {state === 'done' ? <Check className="size-4" /> : index}
      </span>
      <div className="flex min-w-0 flex-col gap-1 pt-1">
        <h2 className={cn('text-base font-semibold tracking-tight', state === 'upcoming' && 'text-muted-foreground')}>
          {title}
          {state === 'done' && <span className="sr-only"> (done)</span>}
        </h2>
        {summary !== undefined && state !== 'current' && <p className="text-sm text-muted-foreground">{summary}</p>}
      </div>
      {state === 'current' && children !== undefined && (
        <div className="col-start-2 flex flex-col gap-4">{children}</div>
      )}
    </li>
  )
}

function CreateStep({ index, state }: { readonly index: number; readonly state: 'done' | 'current' | 'upcoming' }) {
  const create = useCreateAgent()
  const action = useAction(() => create.mutateAsync())
  return (
    <Step index={index} state={state} title="Create your agent wallet" summary="Your agent has its own wallet.">
      <p className="text-sm/relaxed text-muted-foreground text-pretty">
        Your agent gets a wallet of its own, held by a signer that can only follow the limits you set. It can never
        export a key.
      </p>
      <ActionError message={action.error} />
      <Button type="button" disabled={action.pending} onClick={() => void action.start()} className="self-start">
        {action.pending && <Spinner data-icon="inline-start" />}
        Create wallet
      </Button>
    </Step>
  )
}

function UpgradeStep({ index, state }: { readonly index: number; readonly state: 'done' | 'current' | 'upcoming' }) {
  const auth = useAuth()
  const client = useQueryClient()
  const action = useAction(async () => {
    await auth.upgrade('base')
    await client.invalidateQueries({ queryKey: ['me'] })
  })
  return (
    <Step index={index} state={state} title="Upgrade your account on Base" summary="Your account can grant allowances.">
      <p className="text-sm/relaxed text-muted-foreground text-pretty">
        EIP-7702 lets your existing address run a smart-account contract, so it can hand your agent a capped allowance
        without moving your funds or changing your address. You sign once; we pay the gas.
      </p>
      <ActionError message={action.error} />
      <Button type="button" disabled={action.pending} onClick={() => void action.start()} className="self-start">
        {action.pending && <Spinner data-icon="inline-start" />}
        Sign and upgrade
      </Button>
    </Step>
  )
}

function AllowanceStep({ index, state }: { readonly index: number; readonly state: 'done' | 'current' | 'upcoming' }) {
  const auth = useAuth()
  const client = useQueryClient()
  const [perHour, setPerHour] = useState(DEFAULT_PER_HOUR)
  const valid = isPerHour(perHour)
  const action = useAction(async () => {
    await auth.signAllowance({ chain: 'base', perHour, days: DEFAULT_GRANT_DAYS })
    await client.invalidateQueries({ queryKey: ['me'] })
  })
  return (
    <Step
      index={index}
      state={state}
      title="Give your agent an allowance"
      summary="An hourly USDC allowance is signed."
    >
      <p className="text-sm/relaxed text-muted-foreground text-pretty">
        You sign an on-chain allowance: up to this much USDC per hour for {DEFAULT_GRANT_DAYS} days.{' '}
        {LAYERS.onchain.promise} You can revoke it at any time.
      </p>
      <PerHourField id="per-hour" value={perHour} chainName="Base" onChange={setPerHour} />
      <ActionError message={action.error} />
      <Button
        type="button"
        disabled={!valid || action.pending}
        onClick={() => void action.start()}
        className="self-start"
      >
        {action.pending && <Spinner data-icon="inline-start" />}
        Sign allowance
      </Button>
    </Step>
  )
}

function ConnectStep({ index, state }: { readonly index: number; readonly state: 'done' | 'current' | 'upcoming' }) {
  const skip = (): void => {
    try {
      window.localStorage.setItem(SKIP_KEY, '1')
    } catch {
      // expected: storage can be blocked; the owner just goes home
    }
    navigate('/')
    window.location.reload()
  }
  return (
    <Step index={index} state={state} title="Connect goblin" summary="Connect an MCP client when you are ready.">
      <ConnectPanel />
      <div>
        <Button type="button" variant="ghost" onClick={skip}>
          Skip for now
        </Button>
      </div>
    </Step>
  )
}

/** The four steps from a fresh sign-in to a connected agent. Each shows its own error and keeps its place on refresh. */
export function OnboardingPage({ me }: { readonly me: Me }) {
  const connections = useConnections()
  const connected = (connections.data?.length ?? 0) > 0
  const progress = setupProgress(me, connected, readSkipped())
  const order: readonly StepId[] = ['agent', 'upgrade', 'allowance', 'connect']
  const at = progress === 'done' ? order.length : order.indexOf(progress)
  const stateOf = (id: StepId): 'done' | 'current' | 'upcoming' => {
    const position = order.indexOf(id)
    return position < at ? 'done' : position === at ? 'current' : 'upcoming'
  }
  return (
    <Page
      title="Set up your wallet"
      description="Four steps. You can stop and come back; this page picks up where you left off."
    >
      <ol className="flex flex-col">
        <CreateStep index={1} state={stateOf('agent')} />
        <UpgradeStep index={2} state={stateOf('upgrade')} />
        <AllowanceStep index={3} state={stateOf('allowance')} />
        <ConnectStep index={4} state={stateOf('connect')} />
      </ol>
    </Page>
  )
}
