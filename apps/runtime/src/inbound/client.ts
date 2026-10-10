import { type EventWebhookResult, InternalApi } from '@goblin/contracts/internal'
import * as Effect from 'effect/Effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpApiClient from 'effect/http-api/HttpApiClient'
import { type AppError, isAppError, toAppError } from '../http/errors.ts'
import type { EventWebhook } from '../mcp/events.ts'

/** The part of an agent's Durable Object stub the internal API is called through. */
export type AgentFetch = { readonly fetch: (request: Request) => Promise<Response> }

/** The internal API's typed client (`@goblin/contracts/internal`). */
export type InternalClient = HttpApiClient.ForApi<typeof InternalApi>

/** `agent`'s own `fetch` as the HTTP client's transport. */
const transport = (agent: AgentFetch) =>
  // SAFETY: the HTTP client calls its Fetch only as `fetch(url, init)`; nothing reads the members some runtimes' types
  // add to `fetch` (Bun's `preconnect`, which the web's typecheck of the Worker sees).
  ((input: RequestInfo | URL, init?: RequestInit) => agent.fetch(new Request(input, init))) as typeof globalThis.fetch

/**
 * One call of the agent's internal API over `agent`'s own `fetch`, quoting `ref` (the Worker's reference for the
 * request it serves): its value, or the `AppError` the agent answered. Anything else (the stub failed, an answer that
 * does not decode) is ours: reported, and `Internal`.
 */
export const internalCall = <A, E>(
  agent: AgentFetch,
  call: (api: InternalClient) => Effect.Effect<A, E>,
  ref?: string,
): Effect.Effect<A, AppError> =>
  HttpApiClient.make(InternalApi, {
    baseUrl: 'https://agent',
    ...(ref === undefined
      ? {}
      : { transformClient: HttpClient.mapRequest(HttpClientRequest.setHeader('x-goblin-ref', ref)) }),
  }).pipe(
    Effect.flatMap(call),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, transport(agent)),
    Effect.catch((failure) => Effect.fail(isAppError(failure) ? failure : toAppError(failure, 'internal.call'))),
  )

/**
 * An MCP Events webhook delivered to the agent's ingress (`/internal/mcp-events`), as the sender's answer. A failure
 * of ours, a plan lookup that failed among them, is transient: 503, so the sender keeps the subscription and retries.
 * Any other failure (no plan, a bad signature) is that failure.
 */
export const deliverEvents = (
  agent: AgentFetch,
  webhook: EventWebhook,
  ref?: string,
): Effect.Effect<EventWebhookResult, AppError> =>
  internalCall(
    agent,
    (api) =>
      api.inbound.mcpEvents({
        payload: webhook.body,
        headers: {
          'x-mcp-subscription-id': webhook.subscriptionId,
          'webhook-id': webhook.id,
          'webhook-timestamp': webhook.timestamp,
          'webhook-signature': webhook.signature,
        },
      }),
    ref,
  ).pipe(Effect.catchTag('Internal', () => Effect.succeed({ status: 503 } as const)))
