import { Schema } from 'effect'
import type { JsonValue } from '@purrable/contracts'

const ObjectSchema = Schema.Record(Schema.String, Schema.Unknown)
export const isString = Schema.is(Schema.String)
export const isNumber = Schema.is(Schema.Number)
export function record(value: unknown): Record<string, unknown> | undefined {
  return Schema.is(ObjectSchema)(value) ? value : undefined
}
export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item: unknown) => {
        const parsed = record(item)
        return parsed ? [parsed] : []
      })
    : []
}
export function text(value: unknown): string {
  if (isString(value)) return value
  return records(value)
    .filter((part) => part.type === 'text')
    .map((part) => (isString(part.text) ? part.text : ''))
    .join('\n')
}
export function identifier(value: unknown): string {
  return isString(value) || isNumber(value) ? String(value) : ''
}
export async function request(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>,
): Promise<JsonValue> {
  // @effect-diagnostics-next-line globalFetch:off -- Browser UI owns this same-origin authenticated request boundary; runtime Effect services cannot access the browser session.
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    ...(body === undefined && extraHeaders === undefined
      ? {}
      : {
          headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extraHeaders },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
    ...(signal ? { signal } : {}),
  })
  const data = Schema.decodeUnknownSync(Schema.MutableJson)(await response.json())
  if (!response.ok)
    throw new Error(isString(record(data)?.error) ? String(record(data)?.error) : `Request failed (${response.status})`)
  return data
}
