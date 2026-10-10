import * as Effect from 'effect/Effect'
import * as Match from 'effect/Match'
import * as Predicate from 'effect/Predicate'
import * as Schema from 'effect/Schema'
import * as SchemaIssue from 'effect/SchemaIssue'
import * as SchemaParser from 'effect/SchemaParser'
import * as SchemaTransformation from 'effect/SchemaTransformation'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'

/**
 * The reference a typed API answer quotes for its failure (the request's cf-ray), so the owner can name it and an
 * operator can find it in the logs. Only the HTTP API stamps it; Durable Object RPC never sets it, so the encoded shape
 * RPC carries is unchanged.
 */
const ref = Schema.optionalKey(Schema.String)

/**
 * The runtime's failure vocabulary. The owner API answers each one in the error envelope below; Durable Object RPC
 * carries them encoded because Workers RPC does not preserve error classes.
 */
export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()('Unauthenticated', {
  reason: Schema.String,
  ref,
}) {}
export class Forbidden extends Schema.TaggedError<Forbidden>()('Forbidden', { reason: Schema.String, ref }) {}
export class GrantDenied extends Schema.TaggedError<GrantDenied>()('GrantDenied', {
  serverId: Schema.String,
  name: Schema.String,
  ref,
}) {}
export class NotFound extends Schema.TaggedError<NotFound>()('NotFound', { what: Schema.String, ref }) {}
export class Conflict extends Schema.TaggedError<Conflict>()('Conflict', { reason: Schema.String, ref }) {}
export class InvalidInput extends Schema.TaggedError<InvalidInput>()('InvalidInput', { reason: Schema.String, ref }) {}
export class PayloadTooLarge extends Schema.TaggedError<PayloadTooLarge>()('PayloadTooLarge', {
  limit: Schema.Number,
  ref,
}) {}
export class ResidentInactive extends Schema.TaggedError<ResidentInactive>()('ResidentInactive', {
  state: Schema.String,
  ref,
}) {}
export class BudgetExhausted extends Schema.TaggedError<BudgetExhausted>()('BudgetExhausted', {
  limit: Schema.Number,
  resetsAt: Schema.Number,
  ref,
}) {}
export class SubscriptionRequired extends Schema.TaggedError<SubscriptionRequired>()('SubscriptionRequired', {
  subscribe: Schema.String,
  ref,
}) {}
export class NeedsAuthorization extends Schema.TaggedError<NeedsAuthorization>()('NeedsAuthorization', {
  serverId: Schema.String,
  ref,
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
  ref,
}) {}
export class Internal extends Schema.TaggedError<Internal>()('Internal', { reason: Schema.String, ref }) {}

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
export type AppErrorTag = AppError['_tag']

/**
 * Each failure's public face on the wire besides its `code` (`codeOf`): a fixed `message` that never carries runtime
 * text, and what to do next when there is something to do.
 */
export const ERROR_COPY = {
  Unauthenticated: { message: 'Your session has ended.', recovery: 'Sign in again.' },
  Forbidden: { message: 'This request is not allowed.' },
  GrantDenied: { message: 'That tool is not enabled.', recovery: 'Turn it on under Connections.' },
  NotFound: { message: 'That does not exist.' },
  Conflict: { message: 'That clashes with something that is already there.', recovery: 'Refresh and try again.' },
  InvalidInput: { message: 'The request was not valid.' },
  PayloadTooLarge: { message: 'That is too large.' },
  ResidentInactive: { message: 'Resident authority is off.', recovery: 'Re-enable it in Settings.' },
  BudgetExhausted: { message: "You have used today's model budget.", recovery: 'It resets at 00:00 UTC.' },
  SubscriptionRequired: { message: 'Subscribe to Pro to use your personal agent.' },
  NeedsAuthorization: { message: 'This server needs to be connected again.' },
  UpstreamMcp: { message: 'The MCP server did not respond as expected.' },
  Internal: { message: 'Something went wrong on our side.', recovery: 'Try again.' },
} as const satisfies Record<AppErrorTag, { readonly message: string; readonly recovery?: string }>

/** `Tag` in lower_snake_case, as `codeOf` spells it; any string for a tag the type does not know. */
type SnakeCase<Tag extends string, Done extends string = ''> = string extends Tag
  ? string
  : Tag extends `${infer Head}${infer Rest}`
    ? SnakeCase<
        Rest,
        `${Done}${Head extends Lowercase<Head> ? Head : `${Done extends '' ? '' : '_'}${Lowercase<Head>}`}`
      >
    : Done

/** A failure's wire code: its tag in lower_snake_case (`NotFound` is `not_found`). */
export type ApiCode = SnakeCase<AppErrorTag>

/** The HTTP status of each failure; the same table as the runtime's `statusOf` in `http/respond.ts`. */
export const statusOf = (error: AppError | typeof AppError.Encoded): number =>
  Match.value(error).pipe(
    Match.tagsExhaustive({
      Unauthenticated: () => 401,
      Forbidden: () => 403,
      GrantDenied: () => 403,
      NotFound: () => 404,
      Conflict: () => 409,
      InvalidInput: () => 400,
      PayloadTooLarge: () => 413,
      ResidentInactive: () => 409,
      BudgetExhausted: () => 429,
      SubscriptionRequired: () => 402,
      NeedsAuthorization: () => 409,
      UpstreamMcp: (upstream) => (upstream.reason === 'timeout' ? 504 : 502),
      Internal: () => 500,
    }),
  )

/**
 * The safe detail fields the classes carry, as they cross the wire. UpstreamMcp's numeric `code` (the remote server's
 * JSON-RPC code) crosses as `rpcCode`, because `code` is the envelope's own.
 */
const DETAIL_FIELDS = {
  recovery: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  what: Schema.optionalKey(Schema.String),
  serverId: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.String),
  subscribe: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Number),
  resetsAt: Schema.optionalKey(Schema.Number),
  rpcCode: Schema.optionalKey(Schema.Number),
  ref,
}

/** Any failure body the API answers: `{ error: { code, message, recovery?, …safe fields, ref? } }`. */
export const ErrorEnvelope = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String, ...DETAIL_FIELDS }),
})
export type ErrorEnvelope = typeof ErrorEnvelope.Type

/** A tag's wire code: the tag in lower_snake_case (`NotFound` is `not_found`). */
export const codeOf = <const Tag extends string>(tag: Tag): SnakeCase<Tag> =>
  // SAFETY: an underscore before each capital but the first, then lower case, is what `SnakeCase` spells.
  tag.replaceAll(/(?<=.)(?=[A-Z])/gu, '_').toLowerCase() as SnakeCase<Tag>
const TAG_OF_CODE: ReadonlyMap<string, string> = new Map(Object.keys(ERROR_COPY).map((tag) => [codeOf(tag), tag]))

/** The envelope body of an encoded failure: its code and fixed copy, then its own safe fields. */
const toWire = (encoded: typeof AppError.Encoded): ErrorEnvelope => {
  const { _tag, ...fields } = encoded
  const rpc = Predicate.hasProperty(fields, 'code') && Predicate.isNumber(fields.code) ? { rpcCode: fields.code } : {}
  return { error: { ...fields, ...rpc, code: codeOf(_tag), ...ERROR_COPY[_tag] } }
}

/** The class's encoded form from a wire detail; the target schema validates it right after. */
const fromWire = ({ code, message: _message, recovery: _recovery, rpcCode, ...fields }: ErrorEnvelope['error']) => ({
  ...fields,
  _tag: TAG_OF_CODE.get(code),
  ...(rpcCode === undefined ? {} : { code: rpcCode }),
})

type AppErrorClass = (typeof AppError.members)[number]

/**
 * The envelope of the failures one HTTP status answers (myapps' `envelope`). It decodes `{ error: { code, … } }` back
 * into the tagged class, and encodes only a failure whose `statusOf` is `status`, so a union of envelopes picks the
 * right one (UpstreamMcp answers 502, or 504 for a timeout).
 */
const envelope = <const Members extends readonly [AppErrorClass, ...AppErrorClass[]]>(
  status: number,
  members: Members,
) => {
  const Target = Schema.Union(members)
  const Wire = Schema.Struct({
    error: Schema.Struct({
      code: Schema.Literals(members.map((member) => codeOf(member.identifier))),
      message: Schema.String,
      ...DETAIL_FIELDS,
    }),
  }).annotate({ identifier: `GoblinError${status}` })
  const decodeTarget = SchemaParser.decodeUnknownEffect(Schema.toEncoded(Target))
  return Wire.pipe(
    Schema.decodeTo(
      Target,
      SchemaTransformation.transformEffect({
        decode: ({ error }) => decodeTarget(fromWire(error)),
        encode: (encoded, options) =>
          statusOf(encoded) === status
            ? Effect.succeed(toWire(encoded))
            : Effect.fail(new SchemaIssue.InvalidValue({ message: `Not a ${status} failure.` }, encoded, options)),
      }),
    ),
    HttpApiSchema.status(status),
  )
}

/** One envelope per status the API answers a failure with. */
export const ApiErrors = {
  invalidInput: envelope(400, [InvalidInput]),
  unauthenticated: envelope(401, [Unauthenticated]),
  subscriptionRequired: envelope(402, [SubscriptionRequired]),
  forbidden: envelope(403, [Forbidden, GrantDenied]),
  notFound: envelope(404, [NotFound]),
  conflict: envelope(409, [Conflict, ResidentInactive, NeedsAuthorization]),
  payloadTooLarge: envelope(413, [PayloadTooLarge]),
  budgetExhausted: envelope(429, [BudgetExhausted]),
  internal: envelope(500, [Internal]),
  upstream: envelope(502, [UpstreamMcp]),
  upstreamTimeout: envelope(504, [UpstreamMcp]),
}

/** Every envelope: the owner gate's error schema, so any owner endpoint can answer any `AppError`. */
export const API_ERRORS = [
  ApiErrors.invalidInput,
  ApiErrors.unauthenticated,
  ApiErrors.subscriptionRequired,
  ApiErrors.forbidden,
  ApiErrors.notFound,
  ApiErrors.conflict,
  ApiErrors.payloadTooLarge,
  ApiErrors.budgetExhausted,
  ApiErrors.internal,
  ApiErrors.upstream,
  ApiErrors.upstreamTimeout,
] as const

/** The envelope body of `error`, for a failure answered outside HttpApi's own encoding. */
export const envelopeOf = (error: AppError): ErrorEnvelope => toWire(Schema.encodeSync(AppError)(error))

/** `error` carrying the reference the API answers it under. */
export const withRef =
  (reference: string) =>
  (error: AppError): Effect.Effect<AppError> =>
    Schema.encodeEffect(AppError)(error).pipe(
      Effect.flatMap((encoded) => Schema.decodeEffect(AppError)({ ...encoded, ref: reference })),
      Effect.orDie,
    )
