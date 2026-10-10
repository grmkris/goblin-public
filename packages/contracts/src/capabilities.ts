import * as Schema from 'effect/Schema'
import { ConversationKind } from './conversations.ts'
import { NonEmptyString } from './ids.ts'

/** A server id as configuration and the owner's added servers spell it. */
const ServerId = Schema.String.check(Schema.isPattern(/^[\w-]{1,64}$/u))
const ToolName = NonEmptyString(256)

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

/** Switch one thing on or off in a conversation, or give a thread its parent's switches again. */
export const CapabilityChange = Schema.Union([
  Schema.Struct({ target: CapabilityTarget, on: Schema.Boolean }),
  Schema.Struct({ reset: Schema.Literal('parent') }),
])
export type CapabilityChange = typeof CapabilityChange.Type

/**
 * What a conversation lets its agent use: each server with at least one granted tool (`on` is the server's switch,
 * each tool its own), each skills library the owner turned on, and whether it may start subagents. `sameAsParent`, on a
 * thread, says whether its switches are those of the conversation it came from.
 */
export const ConversationCapabilities = Schema.Struct({
  thread: Schema.String,
  kind: ConversationKind,
  servers: Schema.Array(
    Schema.Struct({
      serverId: Schema.String,
      label: Schema.String,
      status: Schema.Literals(['connected', 'needs_auth', 'disconnected']),
      on: Schema.Boolean,
      tools: Schema.Array(
        Schema.Struct({ name: Schema.String, title: Schema.optional(Schema.String), on: Schema.Boolean }),
      ),
    }),
  ),
  skills: Schema.Array(Schema.Struct({ serverId: Schema.String, label: Schema.String, on: Schema.Boolean })),
  subagents: Schema.Boolean,
  sameAsParent: Schema.optional(Schema.Boolean),
})
export type ConversationCapabilities = typeof ConversationCapabilities.Type
