// A connected agent in a few words: what it may do with the wallet and when it last did anything.
import type { Connection } from '@goblin/wallet/contract'
import { timeAgo } from '../ui/format.ts'

const KNOWN = new Set(['wallet:read', 'wallet:spend'])

/**
 * What a connection may do, from its scopes: spend within the owner's limits, or only look. A scope the wallet does
 * not know is named as it came, so nothing hides behind a friendly word.
 */
export function accessOf(scopes: readonly string[]): string {
  const base = scopes.includes('wallet:spend')
    ? 'Can spend within your limits'
    : scopes.includes('wallet:read')
      ? 'Can see balances and activity'
      : 'No wallet access'
  const unknown = scopes.filter((scope) => !KNOWN.has(scope))
  return unknown.length === 0 ? base : `${base}; also ${unknown.join(', ')}`
}

/** "Used 5 min ago", or "Not used yet". */
export const lastUsedOf = (connection: Connection, now: number = Date.now()): string =>
  connection.lastUsedAt === undefined ? 'Not used yet' : `Used ${timeAgo(connection.lastUsedAt, now)}`
