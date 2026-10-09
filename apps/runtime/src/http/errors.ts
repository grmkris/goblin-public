import { AppError, Internal, InvalidInput } from '@goblin/contracts/api'
import * as Schema from 'effect/Schema'
import { safeErrorType } from '../telemetry/safety.ts'

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
  UpstreamReason,
} from '@goblin/contracts/api'

const isAppError = Schema.is(AppError)

/**
 * Known failures pass through; anything else becomes `Internal` without leaking its message to the caller. This is the
 * one place an unexpected failure loses its identity, so it is logged here first: its name and a bounded message,
 * never request data (ADR 0024). The log line belongs to the invocation, whose request id Workers Logs keep.
 */
export const toAppError = (cause: unknown): AppError => {
  if (isAppError(cause)) return cause
  if (Schema.isSchemaError(cause)) return new InvalidInput({ reason: 'schema' })
  const name = safeErrorType(cause)
  console.warn(JSON.stringify({ level: 'warn', event: 'unexpected', name, error: safeErrorType(cause) }))
  return new Internal({ reason: 'unexpected' })
}
