import { formatUnits, parseUnits, usdToMicros } from '@goblin/wallet/amounts'
import type { ChainBalance, LimitView, WalletStatus } from '@goblin/wallet/contract'

/** What goblin's `WalletStatus` is derived from. `verified` is false when the chains could not be read. */
export interface StatusInput {
  readonly balances: readonly ChainBalance[]
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

type Readiness = WalletStatus['paid']

function readiness(input: StatusInput, hasFunds: boolean, spendable: boolean): { paid: Readiness; funding: Readiness } {
  const grantLive = Date.parse(input.grantExpiresAt) > input.now && !input.revoked
  if (!input.verified)
    return { paid: input.hasAgent && grantLive ? 'not_verified' : 'blocked', funding: 'not_verified' }
  const funding = hasFunds ? 'ready' : 'blocked'
  return { paid: input.hasAgent && grantLive && spendable ? 'ready' : 'blocked', funding }
}

/** goblin's `WalletStatus` (ADR 0043) from the wallet's balances and limits: readiness, what is left and what can be spent. */
export function deriveStatus(input: StatusInput): WalletStatus {
  const totals = sumBalances(input.balances)
  const remaining = tightestRemaining(input.limits)
  const tokens = [...totals].slice(0, 8).map(([symbol, balance]) => ({
    symbol: short(symbol),
    balance: short(formatUnits(balance, WEI)),
    ...(remaining === undefined ? {} : { remaining: short(formatUnits(remaining, WEI)) }),
    spendable: short(formatUnits(remaining === undefined ? balance : min(balance, remaining), WEI)),
  }))
  const hasFunds = [...totals.values()].some((units) => units > 0n)
  const spendable = tokens.some((token) => parseUnits(token.spendable, WEI) > 0n)
  const hourEnds = input.limits.find((limit) => limit.layer === 'ledger' && limit.period === 'hour')?.periodEndsAt
  return {
    kind: 'wallet',
    ...readiness(input, hasFunds, spendable),
    tokens,
    ...(hourEnds === undefined ? {} : { periodEndsAt: short(hourEnds) }),
    expiresAt: short(input.grantExpiresAt),
  }
}
