import * as Schema from 'effect/Schema'

/** Draft MCP Triggers & Events profile selected by goblin. */
const EventName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
export const EventDescriptor = Schema.Struct({
  name: EventName,
  description: Schema.optional(Schema.String),
  inputSchema: Schema.Record(Schema.String, Schema.Unknown),
  payloadSchema: Schema.Record(Schema.String, Schema.Unknown),
  delivery: Schema.Array(Schema.Literals(['poll', 'webhook'])),
})
export type EventDescriptor = typeof EventDescriptor.Type
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
