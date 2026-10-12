// What the "Add funds" card decides without the network: whether an amount can be quoted, and where a deposit stands
// from Relay's best-effort status and the owner's balance on Base. Relay's keyless status API rate-limits, so its
// silence is not a failure: the balance rising is arrival too.
import type { DepositRequest, DepositStatus, WalletStatusResult } from '@goblin/wallet/contract'
import { unitsOf } from '../views/money.ts'

export const DEPOSIT_CHAINS: readonly DepositRequest['from'][] = ['base', 'arbitrum', 'ethereum']
export const DEPOSIT_ASSETS: readonly DepositRequest['asset'][] = ['USDC', 'ETH']

const DECIMALS: Record<DepositRequest['asset'], number> = { ETH: 18, USDC: 6 }
const AMOUNT = /^(?:0|[1-9]\d{0,30})(?:\.(\d{1,18}))?$/u

/** What is wrong with the amount to send, or undefined when it can be quoted. */
export function amountProblem(amount: string, asset: DepositRequest['asset']): string | undefined {
  const match = AMOUNT.exec(amount)
  if (match === null) return 'Enter an amount like 0.01 or 25.'
  if ((match[1]?.length ?? 0) > DECIMALS[asset]) return `${asset} has at most ${DECIMALS[asset]} decimals.`
  if (unitsOf(amount, DECIMALS[asset]) === 0n) return 'Enter an amount above zero.'
  return undefined
}

/** The asset you want, already on Base: send it straight to your address, no deposit address needed. */
export const needsNoDeposit = (request: Pick<DepositRequest, 'from' | 'asset' | 'receive'>): boolean =>
  request.from === 'base' && request.asset === request.receive

/** The owner's balance of `symbol` on Base in base units, or undefined when Base was not read. */
export function ownerOnBase(
  status: WalletStatusResult | undefined,
  symbol: DepositRequest['receive'],
): bigint | undefined {
  const row = status?.balances.find(
    (entry) => entry.chain === 'base' && entry.holder === 'owner' && entry.symbol === symbol,
  )
  return row === undefined ? undefined : unitsOf(row.balance, row.decimals)
}

export type DepositPhase = 'waiting' | 'unknown' | 'pending' | 'arrived' | 'refunded' | 'failed'

/**
 * Where a deposit stands. Relay's own answer wins when it has one that ends the deposit; otherwise the owner's balance
 * on Base above what it was when the address was made means the money landed, whatever Relay says or does not say.
 */
export function depositPhase(input: {
  readonly relay: DepositStatus['status'] | undefined
  readonly before: bigint | undefined
  readonly now: bigint | undefined
}): DepositPhase {
  const { relay, before, now } = input
  if (relay === 'success') return 'arrived'
  if (relay === 'refunded' || relay === 'failed') return relay
  if (before !== undefined && now !== undefined && now > before) return 'arrived'
  return relay ?? 'waiting'
}

/** The deposit has an outcome; nothing more to follow. */
export const isSettled = (phase: DepositPhase): boolean =>
  phase === 'arrived' || phase === 'refunded' || phase === 'failed'

/** "about 20 seconds", "about 2 minutes". */
export function aboutSeconds(seconds: number): string {
  if (seconds < 90) return `about ${Math.max(1, Math.round(seconds))} seconds`
  return `about ${Math.round(seconds / 60)} minutes`
}
