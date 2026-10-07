import { Schema } from 'effect'

const record = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))

/** JSON-equivalent provider attributes: persisted JSON drops undefined fields and key order is irrelevant. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null)
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      ),
    )
  return JSON.stringify(value) ?? 'undefined'
}

/** These two beta.80 bookkeeping differences are not observable cloud drift. Everything else must agree. */
export function observed(resource: string, value: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...value }
  if (resource === 'Web' && normalized['domain'] !== undefined) {
    const { zone: _zone, ...domain } = record(normalized['domain'])
    normalized['domain'] = domain
  }
  if (resource === 'goblinAuth' && normalized['readReplication'] === undefined)
    normalized['readReplication'] = { mode: 'disabled' }
  return normalized
}
