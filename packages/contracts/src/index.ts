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
