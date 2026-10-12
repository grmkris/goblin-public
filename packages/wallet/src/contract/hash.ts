import type { Terms } from './operations.ts'

/**
 * Canonical JSON (RFC 8785 style for the values the contract uses): object keys sorted recursively, no whitespace,
 * `undefined` members dropped. Both the Worker and the Approve page hash terms with it, so they always agree.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, member]) => member !== undefined)
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`
  }
  throw new Error(`canonicalJson: unsupported ${typeof value}`)
}

/** The hash an approval binds to: `0x` + lower-case hex sha-256 of the terms' canonical JSON. */
export const termsHash = async (terms: Terms): Promise<`0x${string}`> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(terms)))
  return `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}
