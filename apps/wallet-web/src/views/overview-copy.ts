// The sentences the overview says about spending, shared by the dashboard App and Home. Each one names the network and
// the asset, and an amount that could not be read is said to be unknown, never zero.
import type { LimitView } from '@goblin/wallet/contract'
import { CHAIN_LABEL, formatUsd, formatUsdCompact, timeUntil } from '../ui/format.ts'
import { usdOf } from './money.ts'
import type { Blocker, Constraint, NetworkAvailable, NextAction, Spending } from './overview-model.ts'

const PERIOD: Record<LimitView['period'], string> = {
  call: 'per payment',
  hour: 'this hour',
  day: 'today',
  week: 'this week',
  total: 'in total',
}

const RULE: Record<LimitView['period'], string> = {
  call: 'per-payment limit',
  hour: 'hourly limit',
  day: 'daily limit',
  week: 'weekly limit',
  total: 'total limit',
}

/** Whose limit it is, in the owner's words: theirs in this wallet, the client's, or a chain's. */
function ruleOf(limit: LimitView): string {
  if (limit.layer === 'client') return `your MCP client's ${RULE[limit.period]}`
  if (limit.layer === 'tempo') return `the Tempo access key's ${RULE[limit.period]}`
  if (limit.layer === 'onchain') return `your on-chain allowance`
  return `your ${RULE[limit.period]}`
}

const resets = (limit: LimitView, now: number): string =>
  limit.periodEndsAt === undefined ? '' : `, until it resets ${timeUntil(limit.periodEndsAt, now)}`

const money = (micros: bigint): string => formatUsdCompact(usdOf(micros))

/** "USDC on Base". */
export const assetOn = (option: NetworkAvailable): string =>
  `${option.spend.symbol} on ${CHAIN_LABEL[option.spend.chain]}`

/** What sets the amount available now, as one sentence. */
export function constraintText(constraint: Constraint, now: number = Date.now()): string {
  if (constraint.kind === 'funds') return 'That is everything it can reach now.'
  const left = formatUsd(constraint.limit.remaining ?? '0')
  if (constraint.kind === 'allowance')
    return `Your on-chain allowance lets it draw ${left} more from your account ${PERIOD[constraint.limit.period]}${resets(constraint.limit, now)}.`
  return `Held back by ${ruleOf(constraint.limit)}: ${left} left${resets(constraint.limit, now)}.`
}

/** Why the agent cannot spend, as one sentence that says what is true, not what to feel. */
export function blockerText(blocker: Blocker, spending: Spending, now: number = Date.now()): string {
  const network = CHAIN_LABEL[spending.spend.chain]
  const { symbol } = spending.spend
  switch (blocker.kind) {
    case 'no_agent':
      return 'Your agent has no wallet yet.'
    case 'access_ended':
      return blocker.at !== undefined && Date.parse(blocker.at) <= now
        ? "Your agent's access has ended."
        : 'The wallet is not accepting payments from your agent.'
    case 'unread':
      return `Balances on ${network} could not be read, so this is unknown, not zero.`
    case 'no_allowance':
      return `Your account holds ${money(blocker.owner)} ${symbol} on ${network}, but your agent has no allowance to draw on it.`
    case 'allowance_used':
      return `Your allowance on ${network} is used up ${PERIOD[blocker.limit.period]}${resets(blocker.limit, now)}. Your account still holds ${money(blocker.owner)}.`
    case 'limit_reached':
      return `${capitalize(ruleOf(blocker.limit))} is reached${resets(blocker.limit, now)}.`
    case 'elsewhere':
      return `Your account holds ${money(blocker.owner)} ${blocker.symbol} on ${CHAIN_LABEL[blocker.chain]}, which your agent cannot draw on.`
    case 'gas_only':
      return `Only gas (ETH) is here. Your agent pays for services in ${symbol}.`
    case 'no_funds':
      return 'There is nothing to spend yet.'
  }
}

const capitalize = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

/** The button for the next step; waiting for a reset has none. */
export const NEXT_LABEL: Record<NextAction, string | undefined> = {
  finish_setup: 'Finish setup',
  renew_access: 'Review limits',
  refresh: 'Refresh',
  set_allowance: 'Set an allowance',
  add_funds: 'Add funds',
  wait: undefined,
}

/** A limit's amount as the boundary list shows it: the cap of a payment, what is left of a period. */
export function limitValue(limit: LimitView): string {
  if (limit.period === 'call' || limit.remaining === undefined) return `up to ${formatUsd(limit.limit)}`
  // What is left reads at a glance (cut down to the cent, never up); the cap stays exact.
  return `${formatUsdCompact(limit.remaining)} left of ${formatUsd(limit.limit)}`
}
