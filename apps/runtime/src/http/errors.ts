import * as Schema from 'effect/Schema'

/**
 * The runtime's failure vocabulary. Every boundary maps one of these to an HTTP status in `respond.ts`; Durable Object
 * RPC carries them as an encoded `ErrorBody` because Workers RPC does not preserve error classes.
 */
export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()('Unauthenticated', {
  reason: Schema.String,
}) {}
export class Forbidden extends Schema.TaggedError<Forbidden>()('Forbidden', { reason: Schema.String }) {}
export class GrantDenied extends Schema.TaggedError<GrantDenied>()('GrantDenied', {
  serverId: Schema.String,
  name: Schema.String,
}) {}
export class NotFound extends Schema.TaggedError<NotFound>()('NotFound', { what: Schema.String }) {}
export class Conflict extends Schema.TaggedError<Conflict>()('Conflict', { reason: Schema.String }) {}
export class InvalidInput extends Schema.TaggedError<InvalidInput>()('InvalidInput', { reason: Schema.String }) {}
export class PayloadTooLarge extends Schema.TaggedError<PayloadTooLarge>()('PayloadTooLarge', {
  limit: Schema.Number,
}) {}
export class ResidentInactive extends Schema.TaggedError<ResidentInactive>()('ResidentInactive', {
  state: Schema.String,
}) {}
export class BudgetExhausted extends Schema.TaggedError<BudgetExhausted>()('BudgetExhausted', {
  limit: Schema.Number,
  resetsAt: Schema.Number,
}) {}
export class SubscriptionRequired extends Schema.TaggedError<SubscriptionRequired>()('SubscriptionRequired', {
  subscribe: Schema.String,
}) {}
export class NeedsAuthorization extends Schema.TaggedError<NeedsAuthorization>()('NeedsAuthorization', {
  serverId: Schema.String,
}) {}
export const UpstreamReason = Schema.Literals([
  'unauthorized',
  'remote-rpc',
  'transport',
  'timeout',
  'cancelled',
  'unsupported',
  'content-limit',
])
export class UpstreamMcp extends Schema.TaggedError<UpstreamMcp>()('UpstreamMcp', {
  serverId: Schema.String,
  reason: UpstreamReason,
  code: Schema.optional(Schema.Number),
}) {}
export class Internal extends Schema.TaggedError<Internal>()('Internal', { reason: Schema.String }) {}

export const AppError = Schema.Union([
  Unauthenticated,
  Forbidden,
  GrantDenied,
  NotFound,
  Conflict,
  InvalidInput,
  PayloadTooLarge,
  ResidentInactive,
  BudgetExhausted,
  SubscriptionRequired,
  NeedsAuthorization,
  UpstreamMcp,
  Internal,
])
export type AppError = typeof AppError.Type

const isAppError = Schema.is(AppError)

/** Known failures pass through; anything else becomes `Internal` without leaking its message. */
export const toAppError = (cause: unknown): AppError => {
  if (isAppError(cause)) return cause
  if (Schema.isSchemaError(cause)) return new InvalidInput({ reason: 'schema' })
  return new Internal({ reason: 'unexpected' })
}
