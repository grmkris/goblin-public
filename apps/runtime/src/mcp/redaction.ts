import type { JsonValue } from '@goblin/contracts'
import { Predicate } from 'effect'

// Exact credential-shaped keys. A bare token or an asset's rewardToken is public data.
const SECRET_KEY =
  /^(?:(?:access|refresh|id|bearer|api|session)[_-]?token|(?:client[_-]?)?secret|password|authorization|cookie|private[_-]?key|api[_-]?key)$/iu

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
