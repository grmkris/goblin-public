// A paid job on its approval card (ADR 0044): the amount first and largest, the services it runs in order, and the
// wallet's line with the way to its own App; then the action that approves it and lets jobs up to an amount run
// without asking from now on. The amount and the route are read from the call's own arguments, as held.
import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ServerProfile } from '@goblin/contracts'
import { Button } from '@goblin/ui'
import { record, records } from '../lib/values.ts'
import { serverStatusQuery, spendingQuery } from '../mcp/queries.ts'
import { WalletLine } from './first-class.tsx'

/** A plain dollar amount, as the rule takes it. */
const DOLLARS = /^\d{1,6}(?:\.\d{1,2})?$/u

/** The job's amount, from its paid argument as held: a plain decimal, or nothing. */
export const paidAmount = (profile: ServerProfile, args: Readonly<Record<string, unknown>>): string | undefined => {
  const value = profile.spend === undefined ? undefined : args[profile.spend.argument]
  return typeof value === 'string' && /^\d+(?:\.\d{1,6})?$/u.test(value) ? value : undefined
}

/** The services a job runs, in order, each once: Mercator's plan names a service for each of its steps. */
export const routeOf = (
  args: Readonly<Record<string, unknown>>,
): { readonly services: string[]; readonly steps: number } => {
  const nodes = records(record(args.plan)?.nodes)
  const services = nodes.flatMap((node) => (typeof node.serviceId === 'string' ? [node.serviceId.slice(0, 40)] : []))
  return { services: [...new Set(services)], steps: nodes.length }
}

/** How a job's amount reads: `$1.25`, keeping up to six places for a tiny one. */
const priced = (amount: string): string => {
  const [whole = '0', fraction = ''] = amount.split('.')
  const shown = fraction.replace(/0+$/u, '')
  return `$${whole}${shown === '' ? '' : `.${shown.length === 1 ? `${shown}0` : shown}`}`
}

/** What the paid job costs, where it goes, and what the wallet has left. */
export function PaidJob({
  connectionId,
  profile,
  args,
}: {
  readonly connectionId: string
  readonly profile: ServerProfile
  readonly args: Readonly<Record<string, unknown>>
}) {
  const wallet = useQuery(serverStatusQuery(connectionId, true)).data
  const amount = paidAmount(profile, args)
  const { services, steps } = routeOf(args)
  return (
    <div className="paid-job">
      <p className="paid-job-amount">{amount === undefined ? 'No price given' : priced(amount)}</p>
      {services.length > 0 && (
        <p className="paid-job-route">
          {services.join(' → ')}
          <span className="paid-job-steps">{steps === 1 ? '1 step' : `${String(steps)} steps`}</span>
        </p>
      )}
      {wallet != null && (
        <WalletLine wallet={wallet}>
          {profile.app !== undefined && (
            // A plain link: the card also shows outside the router (a Persona's hold, a fixture).
            <a className="cause-link" href={`/connections/${encodeURIComponent(connectionId)}/app`}>
              Open {profile.title}
            </a>
          )}
        </WalletLine>
      )}
    </div>
  )
}

/**
 * Approve, and run jobs up to an amount without asking from now on. The amount starts at the rule already set, else
 * at this job's price rounded up to a whole dollar, never under $5.
 */
export function RunUpTo({
  connectionId,
  amount,
  disabled,
  pending,
  onApprove,
}: {
  readonly connectionId: string
  readonly amount: string | undefined
  readonly disabled: boolean
  readonly pending: boolean
  readonly onApprove: (runUpTo: string) => void
}) {
  const id = useId()
  const rule = useQuery(spendingQuery(connectionId)).data?.perJob
  const start = rule ?? String(Math.max(5, Math.ceil(Number(amount ?? '0'))))
  const [limit, setLimit] = useState<string>()
  const value = limit ?? start
  const valid = DOLLARS.test(value)
  return (
    <span className="run-up-to">
      <Button disabled={disabled || !valid} pending={pending} onClick={() => onApprove(value)}>
        Approve, and up to
      </Button>
      <label htmlFor={id} className="sr-only">
        Run jobs up to this many dollars without asking
      </label>
      <span className="run-up-to-amount">
        $
        <input
          id={id}
          inputMode="decimal"
          value={value}
          aria-invalid={!valid}
          onChange={(event) => setLimit(event.target.value.trim())}
        />
        <span className="run-up-to-note">without asking</span>
      </span>
    </span>
  )
}
