import type { JsonValue } from '@goblin/contracts'
import { Predicate } from 'effect'

// Exact credential-shaped keys. A bare token or an asset's rewardToken is public data.
const SECRET_KEY =
  /^(?:(?:access|refresh|id|bearer|api|session)[_-]?token|(?:client[_-]?)?secret|password|authorization|cookie|private[_-]?key|api[_-]?key)$/iu

const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu
const ASSIGNED = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)\s*[:=]\s*[^\s,;]+/giu

/**
 * Free text with credential-shaped values scrubbed: a JSON document's credential fields (as {@link redactSecretFields}),
 * then `Bearer …` and `api_key=…`-style assignments anywhere in the text. For text kept or shown again (the transcript
 * index, ADR 0035); it is a scrub of obvious shapes, not a guarantee.
 */
export function redactSecretText(text: string): string {
  let safe = text
  try {
    safe = JSON.stringify(redactSecretFields(JSON.parse(text)))
  } catch {
    // Plain text stays text.
  }
  return safe.replace(BEARER, 'Bearer [redacted]').replace(ASSIGNED, '$1=[redacted]')
}

/** Recursively scrub credentials in remote metadata without hiding public asset and usage fields. */
export function redactSecretFields(value: unknown, key = ''): JsonValue {
  if (SECRET_KEY.test(key)) return '[redacted]'
  if (Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value) || value === null)
    return value
  if (Array.isArray(value)) return value.map((item) => redactSecretFields(item))
  if (Predicate.isObject(value))
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactSecretFields(item, name)]))
  return '[unsupported]'
}
