import * as Schema from 'effect/Schema'

/**
 * A refusal the caller can act on: a stable `code`, a sentence for the owner or the model, and what to do next. The
 * owner API turns it into the `ApiError` envelope and the MCP server into a tool error result.
 */
export class WalletFailure extends Schema.TaggedError<WalletFailure>()('WalletFailure', {
  code: Schema.String,
  message: Schema.String,
  status: Schema.Number,
  recovery: Schema.optional(Schema.String),
}) {}

export const failure = (code: string, message: string, status = 400, recovery?: string): WalletFailure =>
  new WalletFailure({ code, message, status, ...(recovery === undefined ? {} : { recovery }) })
