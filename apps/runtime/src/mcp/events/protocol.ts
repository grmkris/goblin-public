import { EventRate } from '@goblin/contracts'
import * as Predicate from 'effect/Predicate'
import * as Schema from 'effect/Schema'

/** The draft Events extension (SEP-3415) as a server may declare it, beside the top-level `capabilities.events`. */
export const EVENTS_EXTENSION = 'io.modelcontextprotocol/events'

/** Draft MCP Triggers & Events profile selected by goblin. */
const EventName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
/**
 * One event a server offers. `title` and `_meta` are read leniently (`eventSuggestion`): whatever they hold, a malformed
 * one never fails the list.
 */
export const EventDescriptor = Schema.Struct({
  name: EventName,
  title: Schema.optional(Schema.Unknown),
  description: Schema.optional(Schema.String),
  inputSchema: Schema.Record(Schema.String, Schema.Unknown),
  payloadSchema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  delivery: Schema.Array(Schema.Literals(['poll', 'webhook'])),
  _meta: Schema.optional(Schema.Unknown),
})
export type EventDescriptor = typeof EventDescriptor.Type

/** Where a server puts its suggestions for one event: `_meta["lol.mysi/suggest"]` (myapps, 2026-10-12). */
const SUGGEST = 'lol.mysi/suggest'
/** How long a suggested title, summary and group may be; the rest is cut. */
const TITLE = 120
const SUMMARY = 300
const GROUP = 60

/**
 * What a server suggests about one of its events (ADR 0041, amended 2026-10-12): a title, a line on what it is, the
 * group it belongs to, whether to set it up and tell the owner, and how often it happens. Claims for the owner's eyes:
 * they pre-select, and never grant or confirm anything.
 */
export type EventSuggestion = {
  readonly title?: string
  readonly summary?: string
  readonly group?: string
  readonly recommended?: boolean
  readonly tellMe?: boolean
  readonly rate?: EventRate
}

const fieldsOf = (value: unknown): { readonly [key: PropertyKey]: unknown } =>
  Predicate.isReadonlyObject(value) && !Array.isArray(value) ? value : {}
/** One line of the server's text, controls and runs of space folded, cut to `max`; none when it is not text or empty. */
const line = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined
  const folded = value.replaceAll(/[\s\p{Cc}]+/gu, ' ').trim()
  return folded === '' ? undefined : folded.slice(0, max)
}
const flag = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)
const isRate = Schema.is(EventRate)

/**
 * The suggestions `descriptor` carries: its `_meta["lol.mysi/suggest"]` fields, the descriptor's own `title` when the
 * suggestion has none. Each field is read on its own, so one malformed field drops only itself.
 */
export function eventSuggestion(descriptor: EventDescriptor): EventSuggestion {
  const suggest = fieldsOf(fieldsOf(descriptor._meta)[SUGGEST])
  const title = line(suggest['title'], TITLE) ?? line(descriptor.title, TITLE)
  const summary = line(suggest['summary'], SUMMARY)
  const group = line(suggest['group'], GROUP)
  const recommended = flag(suggest['recommended'])
  const tellMe = flag(suggest['tellMe'])
  const rate = suggest['rate']
  return {
    ...(title === undefined ? {} : { title }),
    ...(summary === undefined ? {} : { summary }),
    ...(group === undefined ? {} : { group }),
    ...(recommended === undefined ? {} : { recommended }),
    ...(tellMe === undefined ? {} : { tellMe }),
    ...(isRate(rate) ? { rate } : {}),
  }
}
export const EventsListResult = Schema.Struct({
  events: Schema.Array(EventDescriptor),
  nextCursor: Schema.optional(Schema.String),
})
export const EventOccurrence = Schema.Struct({
  eventId: Schema.String,
  name: EventName,
  timestamp: Schema.String,
  data: Schema.Unknown,
  cursor: Schema.optional(Schema.NullOr(Schema.String)),
})
export const EventControl = Schema.Union([
  Schema.Struct({ type: Schema.Literal('verification'), challenge: Schema.String }),
  Schema.Struct({ type: Schema.Literal('gap'), cursor: Schema.String }),
  Schema.Struct({
    type: Schema.Literal('terminated'),
    error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.optional(Schema.String) })),
  }),
])
export const EventEnvelope = Schema.Union([EventOccurrence, EventControl])
export type EventEnvelope = typeof EventEnvelope.Type
export const EventsPollResult = Schema.Struct({
  events: Schema.Array(EventOccurrence),
  cursor: Schema.String,
  truncated: Schema.Boolean,
  hasMore: Schema.Boolean,
  nextPollMs: Schema.optional(Schema.Number),
})
export type EventsPollResult = typeof EventsPollResult.Type
export const EventsSubscribeResult = Schema.Struct({
  id: Schema.String,
  refreshBefore: Schema.String,
  cursor: Schema.optional(Schema.NullOr(Schema.String)),
  truncated: Schema.optional(Schema.Boolean),
  deliveryStatus: Schema.optional(
    Schema.Struct({ active: Schema.Boolean, lastError: Schema.optional(Schema.NullOr(Schema.String)) }),
  ),
})
export type EventsSubscribeResult = typeof EventsSubscribeResult.Type
export const EventsUnsubscribeResult = Schema.Struct({})
