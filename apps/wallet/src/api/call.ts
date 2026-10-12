import type * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { Wiring } from '../context.ts'
import type { WalletEnv } from '../env.ts'
import type { OwnerIdentity } from '../identity.ts'
import type { LedgerApi } from '../ledger/durable.ts'
import type { AuthApi, SubscriptionApi } from '../oauth/durable.ts'
import type { WalletResult } from '../runtime.ts'
import type { WalletFailure } from '../services/errors.ts'
import type { WalletServices } from '../services/index.ts'
import type { RailsPort } from '../services/rails.ts'
import { apiError, failureResponse, json } from '../http.ts'

/** Everything a route handler needs about one authenticated request. */
export interface ApiCall {
  readonly request: Request
  readonly env: WalletEnv
  readonly owner: OwnerIdentity
  readonly origin: string
  readonly params: Readonly<Record<string, string>>
  readonly ledger: LedgerApi
  readonly rails: RailsPort
  readonly auth: AuthApi
  /** Merchant subscriptions (ADR 0054), in the same singleton as OAuth. */
  readonly subscriptions: SubscriptionApi
  readonly wiring: Wiring
  readonly run: <A>(program: Effect.Effect<A, WalletFailure, WalletServices>) => Promise<WalletResult<A>>
}

export type Route = (call: ApiCall) => Promise<Response>

const MAX_BODY_BYTES = 16_384

/** Reads the JSON body against a schema; a bad one is the 400 to send. */
export async function readBody<S extends Schema.Top & Schema.ConstraintDecoder<unknown>>(
  request: Request,
  schema: S,
): Promise<{ ok: true; value: S['Type'] } | { ok: false; response: Response }> {
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES)
    return { ok: false, response: apiError('body_too_large', 'The request body is too large.', 413) }
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text))
  if (decoded === undefined)
    return { ok: false, response: apiError('invalid_request', 'The request body is not what this route takes.', 400) }
  return { ok: true, value: decoded }
}

/** Runs a program and answers its value as JSON, or its refusal as the error envelope. */
export async function answerWith<A>(
  call: ApiCall,
  program: Effect.Effect<A, WalletFailure, WalletServices>,
): Promise<Response> {
  const result = await call.run(program)
  return result.ok ? json(result.value) : failureResponse(result.failure)
}
