import { AppError, Internal } from '@goblin/contracts/api'
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

const isAppError = Schema.is(AppError)

/**
 * Known failures pass through; anything else becomes `Internal` without leaking its message to the caller. That
 * includes a `SchemaError`: a request that does not decode is refused as invalid input where it is decoded (`readJson`,
 * HttpApi's own request decoding), so one that reaches here came from stored data or a value the agent built, which is
 * our fault, not the caller's. This is the one place an unexpected failure loses its identity, so it is reported here
 * first: its type and stack locations, never its message (ADR 0024).
 */
export const toAppError = (cause: unknown): AppError => {
  if (isAppError(cause)) return cause
  writeLine('error', {
    event: 'failure',
    where: 'http.toAppError',
    'error.type': safeErrorType(cause),
    frames: cause instanceof Error ? framesOf(cause) : [],
    severity: 'Error',
  })
  return new Internal({ reason: 'unexpected' })
}
