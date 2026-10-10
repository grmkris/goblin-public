import { AppError, Internal, InvalidInput, NotFound, envelopeOf, statusOf } from '@goblin/contracts/api'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type * as Scope from 'effect/Scope'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import * as HttpApiError from 'effect/http-api/HttpApiError'
import { isAppError } from '../errors.ts'
import type { RequestFacts } from './context.ts'

/** Every API answer: never cached, never sniffed, and quoting the request's reference when there is one. */
export const secured = (response: Response, ref: string | undefined): Response => {
  const result = new Response(response.body, response)
  result.headers.set('cache-control', 'no-store')
  result.headers.set('x-content-type-options', 'nosniff')
  if (ref !== undefined) result.headers.set('x-goblin-ref', ref)
  return result
}

/** The envelope answer of `error`, quoting `ref`. */
export const refusal = (error: AppError, ref: string | undefined): Response => {
  const { error: detail } = envelopeOf(error)
  const body = { error: ref === undefined ? detail : { ...detail, ref } }
  return secured(Response.json(body, { status: statusOf(error) }), ref)
}

/**
 * A request HttpApi could not decode. A path parameter that does not parse names nothing, which the hand-written routes
 * always answered 404; a body, query or header that does not match is invalid input. A response that does not encode
 * is the agent's own fault: none here, so it is answered as internal.
 */
const DECODE_FAILURES: Readonly<Record<HttpApiError.HttpApiSchemaError['kind'], AppError | undefined>> = {
  Params: new NotFound({ what: 'route' }),
  Payload: new InvalidInput({ reason: 'body does not match the expected shape' }),
  Query: new InvalidInput({ reason: 'query does not match the expected shape' }),
  Headers: new InvalidInput({ reason: 'headers do not match the expected shape' }),
  Body: undefined,
  ResponseHeaders: undefined,
}

/**
 * The answer to a request that ended in a failure HttpApi did not answer itself: a typed `AppError` in its envelope, an
 * undecodable request as above, and anything else (a defect, a response that does not encode) as internal. That last
 * one is logged with the route, code and reference only: never its message, which may carry request data (ADR 0024).
 * HttpApi has already reported the cause with its frames.
 */
const renderFailure = (cause: Cause.Cause<unknown>, facts: RequestFacts): Effect.Effect<Response> => {
  const failure = Option.getOrElse(Cause.findErrorOption(cause), () => Cause.squash(cause))
  const known = isAppError(failure)
    ? failure
    : HttpApiError.HttpApiSchemaError.is(failure)
      ? DECODE_FAILURES[failure.kind]
      : undefined
  if (known !== undefined) return Effect.succeed(refusal(known, facts.ref))
  return Effect.logError('http.failure').pipe(
    Effect.annotateLogs({
      event: 'http.failure',
      route: facts.route,
      code: 'internal',
      ...(facts.ref === undefined ? {} : { ref: facts.ref }),
    }),
    Effect.as(refusal(new Internal({ reason: 'unexpected' }), facts.ref)),
  )
}

/** HttpApi answers a body of an unsupported content type with a bare 415; the API answers it as invalid input. */
const unsupported = (response: Response, ref: string | undefined): Response =>
  response.status === 415 ? refusal(new InvalidInput({ reason: 'body is not JSON' }), ref) : response

/**
 * Answer `request` through `http`, an API's router: the response it built, or the envelope of the failure it ended in,
 * with the API's headers either way. `http` carries everything else it needs already.
 */
export const answer = <E>(
  http: Effect.Effect<HttpServerResponse.HttpServerResponse, E, Scope.Scope | HttpServerRequest.HttpServerRequest>,
  request: Request,
  facts: RequestFacts,
): Effect.Effect<Response> =>
  http.pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
    Effect.scoped,
    Effect.map((response) => unsupported(HttpServerResponse.toWeb(response), facts.ref)),
    // expected: every failure becomes its answer; renderFailure logs an internal one, HttpApi reported its cause.
    Effect.catchCause((cause) => renderFailure(cause, facts)),
    Effect.map((response) => secured(response, facts.ref)),
  )
