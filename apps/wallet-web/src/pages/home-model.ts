// Home as data: the owner's total in dollar stablecoins, where it is held, one line on what the agent can spend now,
// and the next setup step. Pure: the status in, plain values out. An amount that could not be read is unknown, never
// zero, and the page shows a placeholder for it rather than a word in place of a figure.
import type { ChainKey, ChainSetup, LimitView, WalletStatusResult } from '@goblin/wallet/contract'
import { CHAIN_LABEL, formatUsdCompact, timeUntil } from '../ui/format.ts'
import { isStable, microsOf, usdOf } from '../views/money.ts'
import { type Blocker, type Spending, spendingOf } from '../views/overview-model.ts'
import type { StepId } from './progress.ts'

const NETWORK_ORDER: readonly ChainKey[] = ['base', 'arbitrum', 'ethereum', 'tempo']

/** The owner's dollar stablecoins, owner and agent together, or unknown when nothing could be read. */
export type Total =
  | { readonly known: true; readonly usd: string; readonly partial: boolean }
  | { readonly known: false }

/** One stablecoin on one network: what the owner's account and the agent's wallet hold, in micro-dollars. */
export interface Holding {
  readonly chain: ChainKey
  readonly symbol: string
  readonly owner: bigint
  readonly agent: bigint
}

/**
 * The total the server summed when it sent one (`stablecoinUsd`), otherwise the stablecoin rows added up here. With no
 * row and no sum, nothing was read, which is unknown rather than $0.
 */
export function totalOf(status: WalletStatusResult | undefined): Total {
  if (status === undefined) return { known: false }
  const partial = status.status.stablecoinUsdPartial === true || (status.unread?.length ?? 0) > 0
  if (status.status.stablecoinUsd !== undefined)
    return { known: true, usd: usdOf(microsOf(status.status.stablecoinUsd)), partial }
  if (status.balances.length === 0) return { known: false }
  const micros = status.balances
    .filter((row) => isStable(row.symbol))
    .reduce((sum, row) => sum + microsOf(row.balance), 0n)
  return { known: true, usd: usdOf(micros), partial }
}

/** Every stablecoin held anywhere, by network (Base first), the owner's and the agent's side by side. Empty when none. */
export function holdingsOf(status: WalletStatusResult | undefined): readonly Holding[] {
  if (status === undefined) return []
  const holdings = new Map<string, { chain: ChainKey; symbol: string; owner: bigint; agent: bigint }>()
  for (const row of status.balances) {
    if (!isStable(row.symbol)) continue
    const key = `${row.chain}:${row.symbol}`
    const entry = holdings.get(key) ?? { chain: row.chain, symbol: row.symbol, owner: 0n, agent: 0n }
    entry[row.holder] += microsOf(row.balance)
    holdings.set(key, entry)
  }
  return [...holdings.values()]
    .filter((holding) => holding.owner + holding.agent > 0n)
    .toSorted((a, b) => NETWORK_ORDER.indexOf(a.chain) - NETWORK_ORDER.indexOf(b.chain))
}

const listOf = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`

/** "USDC on Base", "USDC on Base and Arbitrum", "USDC on Base and USDC.e on Tempo"; undefined when nothing is held. */
export function whereOf(holdings: readonly Holding[]): string | undefined {
  if (holdings.length === 0) return undefined
  const bySymbol = new Map<string, string[]>()
  for (const { symbol, chain } of holdings) bySymbol.set(symbol, [...(bySymbol.get(symbol) ?? []), CHAIN_LABEL[chain]])
  const phrases = [...bySymbol].map(([symbol, chains]) => `${symbol} on ${listOf(chains)}`)
  return phrases.length <= 2 ? phrases.join(' and ') : `Stablecoins on ${holdings.length} networks`
}

/** Where the line under the total sends the owner when the agent cannot spend. */
export interface NextLink {
  readonly label: string
  readonly to: string
}

/**
 * One quiet line under the total: what the agent can spend and within what ("$12.57", "this hour"), or why it cannot
 * and the step that changes it.
 */
export type SpendLine =
  | { readonly tone: 'ok'; readonly amount: string; readonly within: string }
  | { readonly tone: 'blocked'; readonly text: string; readonly next?: NextLink }

const WITHIN: Record<LimitView['period'], string> = {
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

const resets = (limit: LimitView, now: number): string =>
  limit.periodEndsAt === undefined ? '' : ` It resets ${timeUntil(limit.periodEndsAt, now)}.`

const ADD_FUNDS: NextLink = { label: 'Add funds', to: '/add-funds' }
const SETUP: NextLink = { label: 'Finish setup', to: '/setup' }
const LIMITS: NextLink = { label: 'Review limits', to: '/limits' }

const blocked = (text: string, next?: NextLink): SpendLine => ({
  tone: 'blocked',
  text,
  ...(next === undefined ? {} : { next }),
})

/** Each reason the agent cannot spend, in the owner's words, with the one step that changes it. */
function blockedLine(blocker: Blocker, { spend }: Spending, now: number): SpendLine {
  const network = CHAIN_LABEL[spend.chain]
  switch (blocker.kind) {
    case 'no_agent':
      return blocked('Your agent has no wallet yet.', SETUP)
    case 'access_ended':
      return blocker.at !== undefined && Date.parse(blocker.at) <= now
        ? blocked("Your agent's access has ended.", LIMITS)
        : blocked('Your agent cannot spend right now.', LIMITS)
    case 'unread':
      return blocked(`Your balance on ${network} could not be read just now.`)
    case 'no_allowance':
      return blocked(`Your agent has no allowance to spend from your account on ${network}.`, SETUP)
    case 'allowance_used':
      return blocked(`Your agent has used its allowance ${WITHIN[blocker.limit.period]}.${resets(blocker.limit, now)}`)
    case 'limit_reached':
      return blocked(`Your agent has reached its ${RULE[blocker.limit.period]}.${resets(blocker.limit, now)}`)
    case 'elsewhere':
      return blocked(
        `Your ${blocker.symbol} is on ${CHAIN_LABEL[blocker.chain]}, where your agent cannot spend it.`,
        ADD_FUNDS,
      )
    case 'gas_only':
    case 'no_funds':
      return blocked(`Add ${spend.symbol} on ${network} so your agent can spend.`, ADD_FUNDS)
  }
}

/** "Your agent can spend $12.57 this hour", or why it cannot. */
export function spendLineOf(
  status: WalletStatusResult,
  setups: readonly ChainSetup[] | undefined,
  now: number = Date.now(),
): SpendLine {
  const spending = spendingOf(status, { now, ...(setups === undefined ? {} : { setups }) })
  const { blocker, available, constraint } = spending
  if (blocker !== undefined) return blockedLine(blocker, spending, now)
  // Without a blocker the amount was read and is above zero.
  const amount = available.known ? formatUsdCompact(usdOf(available.micros)) : ''
  const within = constraint === undefined || constraint.kind === 'funds' ? 'now' : WITHIN[constraint.limit.period]
  return { tone: 'ok', amount, within }
}

/** The setup steps in order, and the next one in a sentence. */
const STEPS: readonly StepId[] = ['agent', 'fund', 'upgrade', 'allowance']

const STEP_TEXT: Record<StepId, string> = {
  agent: 'Create a wallet for your agent.',
  fund: 'Add USDC on Base to your wallet.',
  upgrade: 'Let your account give your agent an allowance.',
  allowance: 'Choose what your agent can spend an hour.',
}

export interface SetupStep {
  /** 1-based. */
  readonly number: number
  readonly of: number
  readonly text: string
}

export const setupStepOf = (step: StepId): SetupStep => ({
  number: STEPS.indexOf(step) + 1,
  of: STEPS.length,
  text: STEP_TEXT[step],
})
