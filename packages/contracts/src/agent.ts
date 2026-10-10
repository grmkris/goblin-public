import * as Schema from 'effect/Schema'

export const ResidentStatus = Schema.Struct({
  state: Schema.Literals(['active', 'expired', 'revoked', 'never']),
  renewedAt: Schema.optional(Schema.Number),
  expiresAt: Schema.optional(Schema.Number),
  revokedAt: Schema.optional(Schema.Number),
})
export type ResidentStatus = typeof ResidentStatus.Type

/**
 * What the user's agent spent on models today (UTC) against its daily limit, both in estimated Token Plan Credits
 * (ADR 0026), and when the day resets (epoch seconds).
 */
export const UsageToday = Schema.Struct({ used: Schema.Number, limit: Schema.Number, resetsAt: Schema.Number })
export type UsageToday = typeof UsageToday.Type

/** Main's memory: the messages it remembers, and how many of them its newest view summarizes. */
export const MemoryStatus = Schema.Struct({ messages: Schema.Number, summarized: Schema.Number })
export type MemoryStatus = typeof MemoryStatus.Type

/** The Telegram channel: the connection that carries it, or null when it is off. */
export const ChannelStatus = Schema.NullOr(
  Schema.Struct({
    serverId: Schema.String,
    enabledAt: Schema.Number,
    transport: Schema.optional(Schema.Literals(['events', 'doorbell'])),
  }),
)
export type ChannelStatus = typeof ChannelStatus.Type

/** A model the deployment offers. `route` groups models by provider route, because quotas are per route. */
export const ModelOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  route: Schema.String,
  note: Schema.String,
  images: Schema.Boolean,
  /** The context the agent may fill, in tokens; Pi compacts the conversation before it is full. */
  contextWindow: Schema.Number,
})
export type ModelOption = typeof ModelOption.Type

/** The model the user's agent answers with, the deployment default, and every model on offer (default first). */
export const ModelChoice = Schema.Struct({
  current: Schema.String,
  default: Schema.String,
  options: Schema.Array(ModelOption),
})
export type ModelChoice = typeof ModelChoice.Type
