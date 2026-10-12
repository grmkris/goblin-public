// Setup, on one screen: top up the wallet and connect the agent first, both possible at once, then the three steps that
// finish the wallet. Connecting never waits on setup: a connected agent tells the owner what is still missing.
import { Button, Spinner } from '@goblin/ui'
import { DEFAULT_GRANT_DAYS, type Me } from '@goblin/wallet/contract'
import { useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useConnections, useCreateAgent, useStatus } from '../api/queries.tsx'
import { useAuth } from '../app/auth.tsx'
import { cn } from '../ui/index.ts'
import { LAYERS } from '../ui/layer.tsx'
import { Page, Section } from '../ui/page.tsx'
import { AddFundsCard } from './add-funds.tsx'
import { ConnectPanel } from './connect-panel.tsx'
import { fundedOnBase, type StepId, setupProgress } from './progress.ts'
import { ActionError, DEFAULT_PER_HOUR, isPerHour, PerHourField, useAction } from './setup-actions.tsx'

type StepState = 'done' | 'current' | 'upcoming'

function Step({
  index,
  state,
  title,
  summary,
  children,
}: {
  readonly index: number
  readonly state: StepState
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

function CreateStep({ index, state }: { readonly index: number; readonly state: StepState }) {
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

function UpgradeStep({
  index,
  state,
  waiting,
}: {
  readonly index: number
  readonly state: StepState
  /** No USDC on Base yet: the upgrade, whose gas is paid in USDC, opens once the wallet is topped up. */
  readonly waiting: boolean
}) {
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
        without moving your funds or changing your address. You sign twice: the upgrade, then the operation that carries
        it. Its one-time gas, about a cent, is paid in USDC from your own account.
      </p>
      {waiting ? (
        <p className="text-sm text-muted-foreground">Top up first: this opens once USDC is on Base.</p>
      ) : (
        <>
          <ActionError message={action.error} />
          <Button type="button" disabled={action.pending} onClick={() => void action.start()} className="self-start">
            {action.pending && <Spinner data-icon="inline-start" />}
            Sign and upgrade
          </Button>
        </>
      )}
    </Step>
  )
}

function AllowanceStep({ index, state }: { readonly index: number; readonly state: StepState }) {
  const auth = useAuth()
  const client = useQueryClient()
  const [perHour, setPerHour] = useState(DEFAULT_PER_HOUR)
  const valid = isPerHour(perHour)
  const action = useAction(async () => {
    await auth.signAllowance({ chain: 'base', perHour, days: DEFAULT_GRANT_DAYS })
    // The allowance changes what the agent can spend, so Home's summary must not show the old status.
    await Promise.all([
      client.invalidateQueries({ queryKey: ['me'] }),
      client.invalidateQueries({ queryKey: ['status'] }),
    ])
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

function FundingLine({ funded, unread }: { readonly funded: boolean | undefined; readonly unread: boolean }) {
  if (unread)
    return (
      <p className="text-sm text-muted-foreground">
        Your balance on Base could not be read yet. It is checked every few seconds.
      </p>
    )
  if (funded === undefined) return null
  return (
    <p role="status" className="flex items-center gap-2 text-sm">
      <span
        aria-hidden
        className={cn('size-1.5 shrink-0 rounded-full', funded ? 'bg-success' : 'bg-muted-foreground/50')}
      />
      {funded ? 'Your wallet has USDC on Base.' : 'Waiting for USDC on Base.'}
    </p>
  )
}

function TopUp({
  owner,
  funded,
  unread,
}: {
  readonly owner: string
  readonly funded: boolean | undefined
  readonly unread: boolean
}) {
  return (
    <Section title="Top up your wallet">
      <p className="max-w-prose text-sm/relaxed text-muted-foreground text-pretty">
        Your agent spends from here, within limits you set.
      </p>
      <FundingLine funded={funded} unread={unread} />
      <AddFundsCard owner={owner} />
    </Section>
  )
}

function ConnectAgent() {
  const connections = useConnections()
  const clients = connections.data ?? []
  return (
    <Section title="Connect your agent">
      <p className="max-w-prose text-sm/relaxed text-muted-foreground text-pretty">
        You can connect before setup is finished. Your agent will tell you what is still missing.
      </p>
      {clients.length > 0 && (
        <p role="status" className="flex items-center gap-2 text-sm">
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
          Connected: {clients.map((connection) => connection.client).join(', ')}
        </p>
      )}
      <ConnectPanel />
    </Section>
  )
}

/** The three steps that finish the wallet, in order; the one in progress is open. */
function Checklist({ progress }: { readonly progress: StepId | 'done' }) {
  const order: readonly StepId[] = ['agent', 'fund', 'upgrade', 'allowance']
  const at = progress === 'done' ? order.length : order.indexOf(progress)
  const stateOf = (id: StepId): StepState => {
    const position = order.indexOf(id)
    if (position < at) return 'done'
    return position === at ? 'current' : 'upcoming'
  }
  return (
    <Section title="Finish setup">
      <ol className="flex max-w-2xl flex-col rounded-xl bg-card p-5 text-card-foreground ring-1 ring-foreground/10">
        <CreateStep index={1} state={stateOf('agent')} />
        <UpgradeStep
          index={2}
          state={progress === 'fund' ? 'current' : stateOf('upgrade')}
          waiting={progress === 'fund'}
        />
        <AllowanceStep index={3} state={stateOf('allowance')} />
      </ol>
    </Section>
  )
}

/** One screen until the wallet is set up: top up and connect at the top, side by side when there is room. */
export function OnboardingPage({ me }: { readonly me: Me }) {
  const beforeUpgrade = me.agent !== undefined && me.chains.find((chain) => chain.chain === 'base')?.upgraded !== true
  // Until the upgrade, the balance on Base decides the step: check it while the owner may be sending.
  const status = useStatus(beforeUpgrade ? 10_000 : false)
  const funded = fundedOnBase(status.data)
  const unread = me.agent !== undefined && (status.isError || (status.isSuccess && funded === undefined))
  return (
    <Page
      title="Set up your wallet"
      description="Top up and connect your agent now. Finish setup below when you are ready."
    >
      <div className="@container">
        <div className="grid gap-10 @4xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] @4xl:gap-8">
          <TopUp owner={me.owner} funded={me.agent === undefined ? undefined : funded} unread={unread} />
          <ConnectAgent />
        </div>
      </div>
      <Checklist progress={setupProgress(me, { funded })} />
    </Page>
  )
}
