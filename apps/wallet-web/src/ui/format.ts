// Display helpers. Money is shown exactly as the contract carries it: "0.007" stays "$0.007", never "$0.01".
import type { ChainKey } from '@goblin/wallet/contract'

const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/gu, ',')

/** "0.007" -> "$0.007", "5" -> "$5.00", "1234.5" -> "$1,234.50". Trailing zeros go, but cents always show. */
export function formatUsd(usd: string): string {
  const [whole = '0', fraction = ''] = usd.split('.')
  const trimmed = fraction.replace(/0+$/u, '')
  return `$${group(whole)}.${trimmed.padEnd(2, '0')}`
}

/** A token quantity in its own decimals without trailing zeros: "0.007", "12". */
export function formatToken(amount: string): string {
  const [whole = '0', fraction = ''] = amount.split('.')
  const trimmed = fraction.replace(/0+$/u, '')
  return trimmed === '' ? group(whole) : `${group(whole)}.${trimmed}`
}

/**
 * A balance at a glance: whole cents, cut down and never rounded up. Below a cent it stays exact, so a balance of
 * $0.007 reads "$0.007", never "$0.00" or "$0.01". Transactions keep `formatUsd`.
 */
export function formatUsdCompact(usd: string): string {
  const [whole = '0', fraction = ''] = usd.split('.')
  const cents = fraction.slice(0, 2).padEnd(2, '0')
  if (whole === '0' && cents === '00' && /[1-9]/u.test(fraction)) return formatUsd(usd)
  return `$${group(whole)}.${cents}`
}

const SIGNIFICANT = 4

/**
 * A token quantity at a glance: four decimals above one, four significant digits below it, cut down. A positive
 * quantity never reads as zero: 0.000597817944927921 is "0.0005978".
 */
export function formatTokenCompact(amount: string): string {
  const [whole = '0', fraction = ''] = amount.split('.')
  const zeros = whole === '0' ? (/^0*/u.exec(fraction)?.[0].length ?? 0) : 0
  const kept = fraction.slice(0, zeros + SIGNIFICANT).replace(/0+$/u, '')
  return kept === '' ? group(whole) : `${group(whole)}.${kept}`
}

/** `0x1234…abcd`. */
export function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function span(ms: number): string {
  const abs = Math.abs(ms)
  if (abs < MINUTE) return 'a moment'
  if (abs < HOUR) return `${Math.round(abs / MINUTE)} min`
  if (abs < DAY) return `${Math.round(abs / HOUR)} h`
  return `${Math.round(abs / DAY)} d`
}

/** "5 min ago", "just now". Older than a week shows the date. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  const diff = now - at
  if (diff < MINUTE) return 'just now'
  if (diff > 7 * DAY) return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return `${span(diff)} ago`
}

/** "in 41 min", "in 6 d"; "now" once past. */
export function timeUntil(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  const diff = at - now
  return diff <= 0 ? 'now' : `in ${span(diff)}`
}

export const CHAIN_LABEL: Record<ChainKey, string> = {
  base: 'Base',
  ethereum: 'Ethereum',
  arbitrum: 'Arbitrum',
  tempo: 'Tempo',
}

export const PERIOD_LABEL = {
  call: 'Per call',
  hour: 'Per hour',
  day: 'Per day',
  week: 'Per week',
  total: 'In total',
} as const
