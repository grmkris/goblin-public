// Setup's first task: USDC on Base in the owner's own account. It pays for what the agent buys, and the setup's gas is
// paid from it in USDC. The balance is read every five seconds until enough is there; Continue waits for it.
import { Button } from '@goblin/ui'
import { useState } from 'react'
import { useStatus } from '../../api/queries.tsx'
import { formatUsdCompact } from '../../ui/format.ts'
import { usdOf } from '../../views/money.ts'
import { FromElsewhere, ReceiveAddress } from '../add-funds.tsx'
import { ownerOnBase } from '../deposit-model.ts'
import { UPGRADE_FEE_BOUND } from '../progress.ts'
import { ScreenHeader, StatusLine } from './ui.tsx'

const POLL_MS = 5000

/** What the balance on Base says, in one line. */
function Arrival({
  held,
  unread,
  arrived,
}: {
  /** USDC on Base in base units; undefined until read. */
  readonly held: bigint | undefined
  readonly unread: boolean
  /** It rose while the owner watched. */
  readonly arrived: boolean
}) {
  if (unread) return <StatusLine tone="attention">Your balance on Base could not be read. Checking again…</StatusLine>
  if (held === undefined || held === 0n) return <StatusLine tone="waiting">Waiting for USDC on Base…</StatusLine>
  const amount = formatUsdCompact(usdOf(held))
  if (held < UPGRADE_FEE_BOUND)
    return (
      <StatusLine tone="attention">
        {amount} is here. Setup needs at least {formatUsdCompact(usdOf(UPGRADE_FEE_BOUND))} on Base.
      </StatusLine>
    )
  return <StatusLine tone="done">{arrived ? `Received ${amount}` : `You have ${amount} on Base`}</StatusLine>
}

export function FundStep({
  owner,
  client,
  step,
  total,
  level,
  onContinue,
}: {
  readonly owner: string
  /** The agent's client, for "so goblin can work"; "your agent" without one. */
  readonly client: string | undefined
  readonly step: number
  readonly total: number
  readonly level: 1 | 2
  readonly onContinue: () => void
}) {
  const [polling, setPolling] = useState(true)
  const status = useStatus(polling ? POLL_MS : false)
  const held = ownerOnBase(status.data, 'USDC')
  const enough = held !== undefined && held >= UPGRADE_FEE_BOUND
  // Polling stops once enough is there; what was held at the first read tells "Received" from "You have".
  const [firstRead, setFirstRead] = useState<bigint>()
  if (held !== undefined && firstRead === undefined) setFirstRead(held)
  if (enough && polling) setPolling(false)
  const unread = status.isError || (status.isSuccess && held === undefined)
  return (
    <section className="flex flex-col gap-8">
      <ScreenHeader step={step} total={total} title="Add funds" level={level}>
        Send USDC on Base to your wallet. Gas for the setup is about a cent, paid in USDC.
      </ScreenHeader>
      <ReceiveAddress owner={owner} />
      <div className="flex flex-col gap-2 text-center">
        <Arrival held={held} unread={unread} arrived={firstRead !== undefined && firstRead < UPGRADE_FEE_BOUND} />
        <p className="text-sm text-muted-foreground text-pretty">
          Add at least $5 so {client ?? 'your agent'} can work.
        </p>
      </div>
      <Button type="button" size="cta" className="w-full" disabled={!enough} onClick={onContinue}>
        Continue
      </Button>
      <FromElsewhere />
    </section>
  )
}
