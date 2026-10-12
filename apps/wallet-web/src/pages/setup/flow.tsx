// The setup flow, one task per screen, resuming from server state: the agent wallet made for the owner, USDC on Base,
// spending turned on, then whatever the caller shows once the wallet is ready (Done on /setup, Approve on /consent).
import type { Me } from '@goblin/wallet/contract'
import { type ReactNode, useState } from 'react'
import { useStatus } from '../../api/queries.tsx'
import { LoadingBlock } from '../../ui/async.tsx'
import { fundedOnBase, setupProgress } from '../progress.ts'
import { AgentScreen, useAgentWallet } from './agent.tsx'
import { FundStep } from './fund-step.tsx'
import { screenOf, stepOf } from './model.ts'
import { SpendingStep } from './spending-step.tsx'

export function SetupFlow({
  me,
  client,
  total,
  level = 1,
  done,
}: {
  readonly me: Me
  /** The client the owner is connecting, named in the copy; "your agent" without one. */
  readonly client?: string | undefined
  /** How many numbered steps the page has: two here, three when consent's Approve follows. */
  readonly total: number
  readonly level?: 1 | 2
  /** What shows once the wallet is ready. */
  readonly done: ReactNode
}) {
  const agent = useAgentWallet(me)
  const status = useStatus()
  const funded = fundedOnBase(status.data)
  const progress = setupProgress(me, { funded })
  // Funding is a screen of its own until the owner continues from it, even once the USDC has landed; an account that
  // already holds enough at the first read goes straight on.
  const [holdFund, setHoldFund] = useState(false)
  if (progress === 'fund' && !status.isPending && !holdFund) setHoldFund(true)
  const screen = screenOf(progress, holdFund)
  const step = stepOf(screen)
  // Before the upgrade the balance on Base picks the screen: wait for its first read rather than flash the wrong one.
  if (screen === 'fund' && status.isPending) return <LoadingBlock rows={3} />
  switch (screen) {
    case 'agent':
      return <AgentScreen agent={agent} />
    case 'fund':
      return (
        <FundStep
          owner={me.owner}
          client={client}
          step={step ?? 1}
          total={total}
          level={level}
          onContinue={() => setHoldFund(false)}
        />
      )
    case 'spending':
      return <SpendingStep me={me} step={step ?? 2} total={total} level={level} />
    case 'done':
      return done
  }
}
