import * as Schema from 'effect/Schema'

export type JsonObject = { readonly [key: string]: JsonValue }
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject

export type McpServerConfig = {
  readonly serverId: string
  readonly endpoint: string
  readonly issuer?: string
  readonly resource?: string
}

/** Every failed API response: the error tag plus optional safe detail fields. */
export const ApiError = Schema.Struct({
  error: Schema.String,
  reason: Schema.optional(Schema.String),
  serverId: Schema.optional(Schema.String),
})
export type ApiError = typeof ApiError.Type

/** An outbound MCP server as the owner sees it. `live`: a connection is open right now. */
export const ServerView = Schema.Struct({
  serverId: Schema.String,
  endpoint: Schema.String,
  status: Schema.Literals(['connected', 'needs_auth', 'disconnected']),
  live: Schema.Boolean,
  serverName: Schema.optional(Schema.String),
})
export type ServerView = typeof ServerView.Type

/** A discovered remote tool. The hints come from the server and are unverified; only `granted` is ours. */
export const ToolView = Schema.Struct({
  name: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  readOnlyHint: Schema.optional(Schema.Boolean),
  destructiveHint: Schema.optional(Schema.Boolean),
  modelVisible: Schema.Boolean,
  appResource: Schema.optional(Schema.String),
  granted: Schema.Boolean,
})
export type ToolView = typeof ToolView.Type

export const ResidentStatus = Schema.Struct({
  state: Schema.Literals(['active', 'expired', 'revoked', 'never']),
  renewedAt: Schema.optional(Schema.Number),
  expiresAt: Schema.optional(Schema.Number),
  revokedAt: Schema.optional(Schema.Number),
})
export type ResidentStatus = typeof ResidentStatus.Type

/** Model tokens the user's agent spent today (UTC) against its daily limit, and when the day resets (epoch seconds). */
export const UsageToday = Schema.Struct({ used: Schema.Number, limit: Schema.Number, resetsAt: Schema.Number })
export type UsageToday = typeof UsageToday.Type

/**
 * One question the agent asks the owner with `ask_user`. A choice question (`single`, `multi`) offers 2 to 8 options;
 * `allowOther` adds a free answer. The tool result's details are `{ kind: 'question', questions }`.
 */
export const QuestionOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.optional(Schema.String),
})
export const QuestionSpec = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  kind: Schema.Literals(['single', 'multi', 'text']),
  options: Schema.optional(Schema.Array(QuestionOption)),
  allowOther: Schema.optional(Schema.Boolean),
})
export type QuestionSpec = typeof QuestionSpec.Type

/** A model the deployment offers. `route` groups models by provider route, because quotas are per route. */
export const ModelOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  route: Schema.String,
  note: Schema.String,
  images: Schema.Boolean,
})
export type ModelOption = typeof ModelOption.Type

/** The model the user's agent answers with, the deployment default, and every model on offer (default first). */
export const ModelChoice = Schema.Struct({
  current: Schema.String,
  default: Schema.String,
  options: Schema.Array(ModelOption),
})
export type ModelChoice = typeof ModelChoice.Type

/** An MCP client the owner has authorized to use Purrable's /mcp server. */
export const InboundClient = Schema.Struct({
  clientId: Schema.String,
  name: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
  consentedAt: Schema.optional(Schema.String),
})
export type InboundClient = typeof InboundClient.Type
