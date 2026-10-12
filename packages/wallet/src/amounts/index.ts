/** Decimal strings to and from integer base units. Money never passes through a JavaScript number. */

const DECIMAL = /^(?<whole>\d+)(?:\.(?<fraction>\d+))?$/u

/** A rejected amount: the message starts with a stable code (`invalid_amount`, `too_many_decimals`, `invalid_decimals`). */
const reject = (code: 'invalid_amount' | 'too_many_decimals' | 'invalid_decimals', message: string): Error =>
  new Error(`${code}: ${message}`)

const checkDecimals = (decimals: number): void => {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36)
    throw reject('invalid_decimals', `decimals must be an integer from 0 to 36, got ${decimals}`)
}

/** "1.5" with 6 decimals is 1_500_000n. Rejects numbers, signs, exponents, empty strings and excess precision. */
export function parseUnits(value: string, decimals: number): bigint {
  checkDecimals(decimals)
  if (typeof value !== 'string') throw reject('invalid_amount', 'amount must be a decimal string')
  const groups = DECIMAL.exec(value)?.groups
  const whole = groups?.['whole']
  if (whole === undefined) throw reject('invalid_amount', `not a plain decimal amount: "${value}"`)
  const fraction = groups?.['fraction'] ?? ''
  if (fraction.length > decimals)
    throw reject('too_many_decimals', `"${value}" has more than ${decimals} decimal places`)
  return BigInt(whole + fraction.padEnd(decimals, '0'))
}

/** 1_500_000n with 6 decimals is "1.5": the shortest exact decimal string. */
export function formatUnits(units: bigint, decimals: number): string {
  checkDecimals(decimals)
  if (units < 0n) throw reject('invalid_amount', 'amount must not be negative')
  const digits = units.toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/u, '')
  return fraction === '' ? whole : `${whole}.${fraction}`
}

/** Micro-dollars: one millionth of a US dollar, the ledger's unit. */
export const MICRO_DECIMALS = 6

/** "12.34" dollars is 12_340_000n micro-dollars. */
export const usdToMicros = (usd: string): bigint => parseUnits(usd, MICRO_DECIMALS)

/** 12_340_000n micro-dollars is "12.34". */
export const microsToUsd = (micros: bigint): string => formatUnits(micros, MICRO_DECIMALS)
