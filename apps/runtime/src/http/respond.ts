import { codeOf } from '@goblin/contracts/api'
import * as Match from 'effect/Match'
import * as Schema from 'effect/Schema'
import { AppError, toAppError } from './errors.ts'
import { writeLine } from '../observability/logger.ts'
import { routeTemplate } from './api/context.ts'
import { expectedFailure } from '../telemetry/safety.ts'

export const statusOf = (error: AppError): number =>
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

/** Public error body: the tag plus safe, non-secret fields. Never the cause, a token or a request body. */
export const errorBody = (error: AppError): Record<string, unknown> => {
  const { _tag, ...fields } = Schema.encodeSync(AppError)(error)
  return { error: _tag, ...fields }
}

export const secured = (response: Response): Response => {
  const result = new Response(response.body, response)
  result.headers.set('cache-control', 'no-store')
  result.headers.set('x-content-type-options', 'nosniff')
  return result
}

/** One structured log line per failed request: route, status, code and reference. Bodies and credentials never. */
export const failureResponse = (cause: unknown, route: string, requestId: string): Response => {
  const error = toAppError(cause)
  const status = statusOf(error)
  writeLine(status >= 500 ? 'error' : expectedFailure(error._tag) ? 'info' : 'warn', {
    event: 'http.failure',
    route: routeTemplate(route),
    status,
    code: codeOf(error._tag),
    ref: requestId,
  })
  return secured(Response.json(errorBody(error), { status }))
}

export const requestIdOf = (request: Request): string => request.headers.get('cf-ray') ?? crypto.randomUUID()
