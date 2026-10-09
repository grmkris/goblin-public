import * as Schema from 'effect/Schema'

/** A server id as configuration and the owner's added servers spell it. */
const ServerId = Schema.String.check(Schema.isPattern(/^[\w-]{1,64}$/u))
const ToolName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))

/**
 * One thing a conversation can switch off for its agent: a connected server, one of that server's granted tools, the
 * server's skills library, or starting subagents. Switching off only narrows the owner's grants (ADR 0010).
 */
export const CapabilityTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('server'), serverId: ServerId }),
  Schema.Struct({ kind: Schema.Literal('tool'), serverId: ServerId, name: ToolName }),
  Schema.Struct({ kind: Schema.Literal('skills'), serverId: ServerId }),
  Schema.Struct({ kind: Schema.Literal('subagents') }),
])
export type CapabilityTarget = typeof CapabilityTarget.Type

/** A helper may narrow its inherited execution capabilities, never grant new ones. */
export const HelperExclusion = Schema.Union([
  CapabilityTarget,
  Schema.Struct({ kind: Schema.Literal('app'), app: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,23}$/u)) }),
])
export type HelperExclusion = typeof HelperExclusion.Type
export const HelperExclusions = Schema.Array(HelperExclusion).check(Schema.isMaxLength(100))
