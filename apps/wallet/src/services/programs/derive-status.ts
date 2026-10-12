import { formatUnits, parseUnits, usdToMicros } from '@goblin/wallet/amounts'
import type { ChainBalance, ChainKey, LimitView, WalletStatus } from '@goblin/wallet/contract'

/**
 * What goblin's `WalletStatus` is derived from. `verified` is false when the chains could not be read at all; `unread`
 * names the chains that could not be read this time (their balances are absent, unknown rather than zero).
 */
export interface StatusInput {
  readonly balances: readonly ChainBalance[]
  readonly unread: readonly ChainKey[]
  readonly limits: readonly LimitView[]
  readonly verified: boolean
  readonly hasAgent: boolean
  readonly revoked: boolean
  readonly grantExpiresAt: string
  readonly now: number
}

const WEI = 18
const MICROS_TO_WEI = 10n ** 12n

const sumBalances = (balances: readonly ChainBalance[]): Map<string, bigint> => {
  const totals = new Map<string, bigint>()
  for (const balance of balances) {
    const units = parseUnits(balance.balance, WEI)
    totals.set(balance.symbol, (totals.get(balance.symbol) ?? 0n) + units)
  }
  return totals
}

/** The layers that let the agent draw on the owner's account, each on its own chain. */
const REACHES_OWNER: ReadonlySet<LimitView['layer']> = new Set(['onchain', 'tempo'])

/**
 * The balances the agent can actually pay from: its own, and the owner's only on a chain where an allowance (or a
 * Tempo access key) lets it draw on them. The owner's funds elsewhere are held, not spendable.
 */
const usable = (balances: readonly ChainBalance[], limits: readonly LimitView[]): readonly ChainBalance[] => {
  const reachable = new Set(
    limits.flatMap((limit) => (REACHES_OWNER.has(limit.layer) && limit.chain !== undefined ? [limit.chain] : [])),
  )
  return balances.filter((balance) => balance.holder === 'agent' || reachable.has(balance.chain))
}

/** The smallest "remaining" any layer reports for a rolling or total limit, in wei-scaled dollars; per-call limits cap it too. */
const tightestRemaining = (limits: readonly LimitView[]): bigint | undefined => {
  const values = limits.flatMap((limit) => {
    if (limit.remaining !== undefined) return [usdToMicros(limit.remaining) * MICROS_TO_WEI]
    return limit.period === 'call' ? [usdToMicros(limit.limit) * MICROS_TO_WEI] : []
  })
  return values.length === 0 ? undefined : values.reduce((a, b) => (a < b ? a : b))
}

const short = (value: string): string => value.slice(0, 64)
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b)

/** The dollar stablecoins the wallet holds: USDC on the EVM chains, USDC.e and pathUSD on Tempo, each worth one dollar. */
const STABLECOINS: ReadonlySet<string> = new Set(['USDC', 'USDC.e', 'pathUSD'])

/**
 * The stablecoin dollars the owner and the agent hold on every chain that was read, summed in base units. None when no
 * chain could be read; partial when some could not, since their funds are unknown rather than zero.
 */
const stablecoins = (input: StatusInput): Pick<WalletStatus, 'stablecoinUsd' | 'stablecoinUsdPartial'> => {
  if (!input.verified) return {}
  const held = input.balances.filter((balance) => STABLECOINS.has(balance.symbol))
  const total = held.reduce((sum, balance) => sum + parseUnits(balance.balance, WEI), 0n)
  return {
    stablecoinUsd: short(formatUnits(total, WEI)),
    ...(input.unread.length === 0 ? {} : { stablecoinUsdPartial: true as const }),
  }
}

type Readiness = WalletStatus['paid']

/** A chain that could not be read turns a "no" into "not verified": the money may be there. A "yes" stands. */
function readiness(input: StatusInput, hasFunds: boolean, spendable: boolean): { paid: Readiness; funding: Readiness } {
  const grantLive = Date.parse(input.grantExpiresAt) > input.now && !input.revoked
  if (!input.verified)
    return { paid: input.hasAgent && grantLive ? 'not_verified' : 'blocked', funding: 'not_verified' }
  const partial = input.unread.length > 0
  const funding = hasFunds ? 'ready' : partial ? 'not_verified' : 'blocked'
  const allowed = input.hasAgent && grantLive
  return { paid: allowed && spendable ? 'ready' : allowed && partial ? 'not_verified' : 'blocked', funding }
}

/**
 * goblin's `WalletStatus` (ADR 0043) from the wallet's balances and limits: readiness, what is held, what is left and what
 * can be spent (from the funds the agent can reach, under the tightest layer).
 */
export function deriveStatus(input: StatusInput): WalletStatus {
  const totals = sumBalances(input.balances)
  const reachable = sumBalances(usable(input.balances, input.limits))
  const remaining = tightestRemaining(input.limits)
  const tokens = [...totals].slice(0, 8).map(([symbol, balance]) => {
    const funds = reachable.get(symbol) ?? 0n
    return {
      symbol: short(symbol),
      balance: short(formatUnits(balance, WEI)),
      ...(remaining === undefined ? {} : { remaining: short(formatUnits(remaining, WEI)) }),
      spendable: short(formatUnits(remaining === undefined ? funds : min(funds, remaining), WEI)),
    }
  })
  const hasFunds = [...totals.values()].some((units) => units > 0n)
  const spendable = tokens.some((token) => parseUnits(token.spendable, WEI) > 0n)
  const hourEnds = input.limits.find((limit) => limit.layer === 'ledger' && limit.period === 'hour')?.periodEndsAt
  return {
    kind: 'wallet',
    ...readiness(input, hasFunds, spendable),
    tokens,
    ...(hourEnds === undefined ? {} : { periodEndsAt: short(hourEnds) }),
    expiresAt: short(input.grantExpiresAt),
    ...stablecoins(input),
  }
}
