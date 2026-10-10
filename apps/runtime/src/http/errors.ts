import { AppError, Internal } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { writeLine } from '../observability/logger.ts'
import { framesOf, safeErrorType } from '../observability/report.ts'

/**
 * The runtime's failure vocabulary lives with the API contract (`@goblin/contracts/api`), which answers each one in its
 * error envelope. Every boundary maps one to an HTTP status (`respond.ts`); Durable Object RPC carries them as an
 * encoded `ErrorBody` because Workers RPC does not preserve error classes. Re-exported here so runtime imports stay.
 */
export {
  AppError,
  BudgetExhausted,
  Conflict,
  Forbidden,
  GrantDenied,
  Internal,
  InvalidInput,
  NeedsAuthorization,
  NotFound,
  PayloadTooLarge,
  ResidentInactive,
  SubscriptionRequired,
  Unauthenticated,
  UpstreamMcp,
} from '@goblin/contracts/api'

/** Whether `cause` is one of the runtime's typed failures. */
export const isAppError = Schema.is(AppError)

/**
 * The frames a failure line keeps: only those that end in a location (`file:line:col`). The logger drops a frames list
 * whole when one entry is not a location (`at async Promise.all (index 0)`), so those are left out first.
 */
const LOCATION = /:\d{1,7}:\d{1,7}\)?$/u
const locatedFrames = (cause: unknown): string[] =>
  cause instanceof Error ? framesOf(cause).filter((frame) => LOCATION.test(frame)) : []

/**
 * Known failures pass through; anything else becomes `Internal` without leaking its message to the caller. That
 * includes a `SchemaError`: a request that does not decode is refused as invalid input where it is decoded (`readJson`,
 * HttpApi's own request decoding), so one that reaches here came from stored data or a value the agent built, which is
 * our fault, not the caller's. This is the one place an unexpected failure loses its identity, so it is reported here
 * first, under `where`: its type and stack locations, never its message (ADR 0024).
 */
export const toAppError = (cause: unknown, where = 'http.toAppError'): AppError => {
  if (isAppError(cause)) return cause
  writeLine('error', {
    event: 'failure',
    where,
    'error.type': safeErrorType(cause),
    frames: locatedFrames(cause),
    severity: 'Error',
  })
  return new Internal({ reason: 'unexpected' })
}

/**
 * A call into Promise code as an Effect: it fails with the `AppError` the call threw, anything else `Internal` (reported
 * under `where`, see `toAppError`).
 */
export const attempt = <A>(call: () => PromiseLike<A>, where?: string): Effect.Effect<A, AppError> =>
  Effect.tryPromise({ try: call, catch: (cause) => toAppError(cause, where) })

/** A call into synchronous code that throws its typed failures, taken the same way. */
export const attemptSync = <A>(call: () => A, where?: string): Effect.Effect<A, AppError> =>
  Effect.try({ try: call, catch: (cause) => toAppError(cause, where) })
