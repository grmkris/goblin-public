/**
 * A fetch-only Privy REST client, ported from Sidequest's `packages/sdk/src/privy-server.ts` and
 * `scripts/privy/client.ts`. Basic auth with the app secret; wallet-acting requests also carry a P-256 authorization
 * signature over the canonical request (`formatAuthorizationPayload`). Errors expose only the HTTP status and a
 * bounded machine code: Privy's messages can echo request bodies.
 */
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { canonicalJson } from '../contract/hash.ts'
import type { AuthorizationSigner } from './p256.ts'

export const PRIVY_API = 'https://api.privy.io/v1'

/** A refused or failed Privy call: `status` 0 means no answer (network, timeout, missing credentials). */
export class PrivyError extends Schema.TaggedError<PrivyError>()('PrivyError', {
  status: Schema.Number,
  code: Schema.String,
  route: Schema.String,
  message: Schema.String,
}) {}

export const privyError = (status: number, code: string, route: string): PrivyError =>
  new PrivyError({ status, code, route, message: `Privy ${route}: HTTP ${status} (${code})` })

/** The payload Privy's `privy-authorization-signature` signs: RFC 8785 JSON of the request and its privy headers. */
export const formatAuthorizationPayload = (input: {
  readonly method: string
  readonly url: string
  readonly body: unknown
  readonly headers: Readonly<Record<string, string>>
}): string =>
  canonicalJson({
    version: 1,
    method: input.method.toUpperCase(),
    url: input.url,
    body: input.body,
    headers: input.headers,
  })

export interface PrivyConfig {
  readonly appId: string
  readonly appSecret: string
  /** Signs wallet-acting requests: the routine signer key for RPC, the policy-admin key for policy updates. */
  readonly authorize?: AuthorizationSigner
  readonly fetch?: typeof fetch
  /** Epoch milliseconds, for `privy-request-expiry`. */
  readonly now?: () => number
}

export type PrivyMethod = 'GET' | 'POST' | 'PATCH'

export interface PrivyRequestOptions {
  /** Privy's idempotency key: a retry with the same key and body returns the first answer instead of acting twice. */
  readonly idempotencyKey?: string
  /** Attach the authorization signature (wallet RPC, policy updates). */
  readonly signed?: boolean
}

const ROUTE = /^\/(?:wallets|users|key_quorums|policies)(?:\/[A-Za-z0-9_-]+)*(?:\?[A-Za-z0-9_=&%.:-]*)?$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,256}$/u
const CODE = /^[A-Za-z0-9_-]{1,80}$/u
const EXPIRY_MS = 60_000
const TIMEOUT_MS = 30_000

const JsonObject = Schema.Record(Schema.String, Schema.Unknown)
const decodeObject = Schema.decodeUnknownOption(JsonObject)
const asObject = (value: unknown): Record<string, unknown> => Option.getOrElse(decodeObject(value), () => ({}))

/** A Privy id as one path segment; refuses anything that could change the route. */
export const privyId = (value: string): string => {
  if (!/^[A-Za-z0-9:_-]{1,200}$/u.test(value)) throw privyError(0, 'invalid_identifier', 'id')
  return encodeURIComponent(value)
}

/** JSON's own view of the body: undefined members gone, so the signed payload equals what is sent. */
const plain = (body: unknown): unknown => (body === undefined ? {} : JSON.parse(JSON.stringify(body)))

export class PrivyClient {
  readonly #config: PrivyConfig
  readonly #fetch: typeof fetch
  readonly #now: () => number

  constructor(config: PrivyConfig) {
    this.#config = config
    this.#fetch = config.fetch ?? ((input, init) => fetch(input, init))
    this.#now = config.now ?? Date.now
  }

  get appId(): string {
    return this.#config.appId
  }

  /** One Privy call; resolves with the JSON object answered, rejects with `PrivyError`. */
  async request(
    method: PrivyMethod,
    route: string,
    body?: unknown,
    options: PrivyRequestOptions = {},
  ): Promise<Record<string, unknown>> {
    const { appId, appSecret } = this.#config
    if (appId === '' || appSecret === '') throw privyError(0, 'unconfigured', route)
    if (!ROUTE.test(route)) throw privyError(0, 'invalid_route', route)
    const headers = await this.#headers(method, route, method === 'GET' ? undefined : plain(body), options)
    let response: Response
    try {
      response = await this.#fetch(`${PRIVY_API}${route}`, {
        method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        ...(method === 'GET' ? {} : { body: JSON.stringify(plain(body)) }),
      })
    } catch {
      // expected: a network failure or timeout; the operation key makes a retry safe.
      throw privyError(0, 'unavailable', route)
    }
    // expected: a body that is not JSON is answered as an empty object; the status still decides.
    const json = asObject(await response.json().catch(() => ({})))
    if (response.ok) return json
    const candidate = json['code'] ?? json['error']
    throw privyError(
      response.status,
      typeof candidate === 'string' && CODE.test(candidate) ? candidate : 'refused',
      route,
    )
  }

  async #headers(
    method: PrivyMethod,
    route: string,
    body: unknown,
    options: PrivyRequestOptions,
  ): Promise<Record<string, string>> {
    const { appId, appSecret, authorize } = this.#config
    const privy: Record<string, string> = { 'privy-app-id': appId }
    if (method !== 'GET') privy['privy-request-expiry'] = String(this.#now() + EXPIRY_MS)
    if (options.idempotencyKey !== undefined) {
      if (!IDEMPOTENCY_KEY.test(options.idempotencyKey)) throw privyError(0, 'invalid_idempotency_key', route)
      privy['privy-idempotency-key'] = options.idempotencyKey
    }
    const headers: Record<string, string> = {
      ...privy,
      authorization: `Basic ${btoa(`${appId}:${appSecret}`)}`,
      'content-type': 'application/json',
    }
    if (options.signed === true) {
      if (authorize === undefined) throw privyError(0, 'no_authorization_key', route)
      headers['privy-authorization-signature'] = await authorize(
        formatAuthorizationPayload({ method, url: `${PRIVY_API}${route}`, body: body ?? {}, headers: privy }),
      )
    }
    return headers
  }
}
