import { Schema } from 'effect'

/**
 * Readers for values the page did not type itself: Pi stream frames, App messages, tool payloads. Each answers what it
 * finds, never throws, and is no decoder for an API answer (the typed clients decode those through the contract).
 */
const ObjectSchema = Schema.Record(Schema.String, Schema.Unknown)
export const isString = Schema.is(Schema.String)
export const isNumber = Schema.is(Schema.Number)
/** `value` as a plain object, or undefined. */
export function record(value: unknown): Record<string, unknown> | undefined {
  return Schema.is(ObjectSchema)(value) ? value : undefined
}
/** The plain objects of an array; anything else gives none. */
export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item: unknown) => {
        const parsed = record(item)
        return parsed ? [parsed] : []
      })
    : []
}
/** A string as it is, or the text parts (`{ type: 'text', text }`) of a content array, one per line. */
export function text(value: unknown): string {
  if (isString(value)) return value
  return records(value)
    .filter((part) => part.type === 'text')
    .map((part) => (isString(part.text) ? part.text : ''))
    .join('\n')
}
/** A string or number id as a string; anything else is empty. */
export function identifier(value: unknown): string {
  return isString(value) || isNumber(value) ? String(value) : ''
}
