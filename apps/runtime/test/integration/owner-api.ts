import { OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpApiClient from 'effect/http-api/HttpApiClient'

/** The part of an agent's Durable Object stub the probes call: its `fetch`, as the Worker forwards to it. */
export type AgentFetch = { readonly fetch: (request: Request) => Promise<Response> }

/** The owner API's typed client, as the probes see it. */
export type OwnerClient = HttpApiClient.ForApi<typeof OwnerApi>

/**
 * The typed owner API over one agent's own `fetch`, with what the Worker edge adds to a forwarded request: its
 * reference (`x-goblin-ref`). No cookie reaches the agent; the probes stand where the Worker's admission stood.
 */
export const ownerApi = (agent: AgentFetch, ref = 'integration-probe') =>
  HttpApiClient.make(OwnerApi, {
    baseUrl: 'https://agent',
    transformClient: HttpClient.mapRequest(HttpClientRequest.setHeader('x-goblin-ref', ref)),
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, (input, init) => agent.fetch(new Request(input, init))),
  )

/** One owner API call against `agent`: its value, or a rejection with the typed failure it answered. */
export const callOwner = <A, E>(agent: AgentFetch, call: (api: OwnerClient) => Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.flatMap(ownerApi(agent), call))
