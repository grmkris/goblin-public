// Money as the contract carries it: decimal strings in, integer base units for every sum and comparison, never a
// JavaScript number. Stablecoins count as dollars at face value; ETH is gas and is never added to a dollar figure.
import { formatUnits, parseUnits } from '@goblin/wallet/amounts'

/** The USD stablecoins the wallet counts at face value. ETH and other tokens are listed, never added as dollars. */
const STABLES = new Set(['USDC', 'USDC.e', 'pathUSD'])

const USD_DECIMALS = 6

export const isStable = (symbol: string): boolean => STABLES.has(symbol)

/** A stablecoin or USD amount in micro-dollars. Digits past the sixth decimal are cut, never rounded up. */
export function microsOf(amount: string): bigint {
  const [whole = '0', fraction = ''] = amount.split('.')
  const kept = fraction.slice(0, USD_DECIMALS)
  return parseUnits(kept === '' ? whole : `${whole}.${kept}`, USD_DECIMALS)
}

/** Micro-dollars back to the shortest exact decimal string: 7_000n is "0.007". */
export const usdOf = (micros: bigint): string => formatUnits(micros, USD_DECIMALS)

/** A token quantity in its own base units, for comparing (is there any ETH at all?). */
export const unitsOf = (amount: string, decimals: number): bigint => parseUnits(amount, decimals)

export const sumMicros = (values: readonly bigint[]): bigint => values.reduce((total, value) => total + value, 0n)

/** The smallest of the values, or undefined when there are none. */
export function minMicros(values: readonly bigint[]): bigint | undefined {
  let smallest: bigint | undefined
  for (const value of values) if (smallest === undefined || value < smallest) smallest = value
  return smallest
}

/** For `toSorted`: smaller amounts first. */
export function byMicros(a: bigint, b: bigint): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
