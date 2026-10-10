/** Adapted from myapps@8a69ec64 apps/myplan/src/billing/dodo.ts; injected clients, one server-selected Pro product. */
import type { RuntimeEnv } from '../env.ts'
export type DodoMode = 'test_mode' | 'live_mode'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Predicate from 'effect/Predicate'
import * as Schema from 'effect/Schema'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import { verifyStandardWebhook, type WebhookHeaders } from './standard-webhooks.ts'
import { isRecord } from '../runtime/digest.ts'

/** Dodo did not answer, or answered an error: the caller's request may be retried. */
export class DodoError extends Schema.TaggedError<DodoError>()('DodoError', { message: Schema.String }) {}

/** A webhook that is not signed by this endpoint's key, is stale, or is not an event. */
class WebhookRejected extends Schema.TaggedError<WebhookRejected>()('WebhookRejected', {
  reason: Schema.Literals(['signature', 'body']),
}) {}

/** A verified event: Standard Webhooks' `webhook-id` is the idempotency key. */
export interface VerifiedEvent {
  readonly id: string
  readonly type: string
  /** When Dodo produced it (ms), else when it was sent. */
  readonly timestamp: number
  readonly data: Readonly<Record<string, unknown>>
  /** The verified raw body, kept in the inbox. */
  readonly body: string
}

interface CheckoutRequest {
  /** From the plan table, never from the request. */
  readonly productId: string
  /** The Dodo customer when the person has one, else their email and name. */
  readonly customer: { readonly customerId: string } | { readonly email: string; readonly name?: string }
  readonly returnUrl: string
  /** Echoed in webhooks: the person and the offer they saw. */
  readonly metadata: Readonly<Record<string, string>>
}

export interface DodoApi {
  readonly mode: DodoMode
  readonly createCheckout: (
    request: CheckoutRequest,
  ) => Effect.Effect<{ readonly sessionId: string; readonly checkoutUrl: string }, DodoError>
  readonly portalUrl: (customerId: string) => Effect.Effect<string, DodoError>
  /** A subscription as Dodo has it now (the webhook `data` shape). */
  readonly getSubscription: (subscriptionId: string) => Effect.Effect<Record<string, unknown>, DodoError>
  /** The subscription a payment belongs to, if any. */
  readonly paymentSubscriptionId: (paymentId: string) => Effect.Effect<string | null, DodoError>
  /** Verify a delivery before parsing it; `nowMs` is the clock the tolerance is measured on. */
  readonly verify: (
    headers: WebhookHeaders,
    body: string,
    nowMs: number,
  ) => Effect.Effect<VerifiedEvent, WebhookRejected>
}

export class Dodo extends Context.Service<Dodo, DodoApi>()('goblin/Dodo') {}

/** The event inside a verified body, or null when it is not one. */
const parseEvent = (headers: WebhookHeaders, body: string): VerifiedEvent | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    // expected: a body that is not JSON is no event; the verifier refuses it as such.
    return null
  }
  if (!isRecord(parsed) || !Predicate.isString(parsed['type']) || !isRecord(parsed['data'])) return null
  const stamped = Predicate.isString(parsed['timestamp']) ? Date.parse(parsed['timestamp']) : Number.NaN
  return {
    id: headers.id,
    type: parsed['type'],
    timestamp: Number.isNaN(stamped) ? Number(headers.timestamp) * 1000 : stamped,
    data: parsed['data'],
    body,
  }
}

/** Standard Webhooks verification under `webhookKey`, then the event. */
const verifier =
  (webhookKey: string): DodoApi['verify'] =>
  (headers, body, nowMs) =>
    Effect.gen(function* () {
      const valid = yield* Effect.promise(() => verifyStandardWebhook(webhookKey, headers, body, nowMs))
      if (!valid) return yield* new WebhookRejected({ reason: 'signature' })
      const event = parseEvent(headers, body)
      return event === null ? yield* new WebhookRejected({ reason: 'body' }) : event
    })

const BASE_URL: Readonly<Record<DodoMode, string>> = {
  test_mode: 'https://test.dodopayments.com',
  live_mode: 'https://live.dodopayments.com',
}

const text = (value: unknown, field: string): string => {
  const found = isRecord(value) ? value[field] : undefined
  if (!Predicate.isString(found) || found === '') throw new DodoError({ message: `Dodo's answer has no ${field}` })
  return found
}

/** One call to Dodo's API as JSON; any failure (network, status, shape) is a `DodoError` without the key or body. */
const call = (
  mode: DodoMode,
  apiKey: string,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Effect.Effect<unknown, DodoError> => {
  const url = `${BASE_URL[mode]}${path}`
  const base = method === 'GET' ? HttpClientRequest.get(url) : HttpClientRequest.post(url)
  const request = HttpClientRequest.setHeader(base, 'authorization', `Bearer ${apiKey}`)
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(
      body === undefined ? request : HttpClientRequest.bodyJsonUnsafe(request, body),
    )
    if (response.status < 200 || response.status >= 300)
      return yield* new DodoError({ message: `Dodo answered ${response.status}.` })
    const answer: unknown = yield* response.json
    return answer
  }).pipe(
    Effect.scoped,
    Effect.timeout('15 seconds'),
    Effect.provide(FetchHttpClient.layer),
    Effect.mapError((e) => (e instanceof DodoError ? e : new DodoError({ message: 'Dodo could not be reached.' }))),
  )
}

/** The live API under a mode, an API key and the endpoint's webhook key. */
export const liveApi = (mode: DodoMode, apiKey: string, webhookKey: string): DodoApi => ({
  mode,
  createCheckout: (request) =>
    call(mode, apiKey, 'POST', '/checkouts', {
      product_cart: [{ product_id: request.productId, quantity: 1 }],
      customer:
        'customerId' in request.customer
          ? { customer_id: request.customer.customerId }
          : {
              email: request.customer.email,
              ...(request.customer.name === undefined ? {} : { name: request.customer.name }),
            },
      return_url: request.returnUrl,
      metadata: request.metadata,
    }).pipe(
      Effect.flatMap((answer) =>
        Effect.try({
          try: () => ({ sessionId: text(answer, 'session_id'), checkoutUrl: text(answer, 'checkout_url') }),
          catch: () => new DodoError({ message: 'Dodo answered a checkout without a URL.' }),
        }),
      ),
    ),
  portalUrl: (customerId) =>
    call(mode, apiKey, 'POST', `/customers/${encodeURIComponent(customerId)}/customer-portal/session`).pipe(
      Effect.flatMap((answer) =>
        Effect.try({ try: () => text(answer, 'link'), catch: () => new DodoError({ message: 'No portal link.' }) }),
      ),
    ),
  getSubscription: (subscriptionId) =>
    call(mode, apiKey, 'GET', `/subscriptions/${encodeURIComponent(subscriptionId)}`).pipe(
      Effect.flatMap((answer) =>
        isRecord(answer) ? Effect.succeed(answer) : Effect.fail(new DodoError({ message: 'Not a subscription.' })),
      ),
    ),
  paymentSubscriptionId: (paymentId) =>
    call(mode, apiKey, 'GET', `/payments/${encodeURIComponent(paymentId)}`).pipe(
      Effect.map((answer) => {
        const id = isRecord(answer) ? answer['subscription_id'] : undefined
        return Predicate.isString(id) && id !== '' ? id : null
      }),
    ),
  verify: verifier(webhookKey),
})

/** Unconfigured billing never grants access. Only prod may reach the live API; prod requires live mode. */
export const configuredDodo = (env: RuntimeEnv): DodoApi | undefined => {
  const mode = env.DODO_PAYMENTS_ENVIRONMENT
  if (
    (mode !== 'test_mode' && mode !== 'live_mode') ||
    !env.DODO_PAYMENTS_API_KEY ||
    !env.DODO_PAYMENTS_WEBHOOK_KEY ||
    !env.DODO_PRODUCT_ID
  )
    return undefined
  if ((env.STAGE === 'prod') !== (mode === 'live_mode')) return undefined
  return liveApi(mode, env.DODO_PAYMENTS_API_KEY, env.DODO_PAYMENTS_WEBHOOK_KEY)
}
