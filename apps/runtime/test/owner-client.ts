import { WorkspaceSnapshot } from '@goblin/contracts'
import { AccountApi, OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpApiClient from 'effect/http-api/HttpApiClient'

/** The part of an agent the tests call: its `fetch`, as the Worker forwards to it (a stub's, or a served group's). */
export type AgentFetch = { readonly fetch: (request: Request) => Promise<Response> }

/** The owner API's typed client, as the tests see it. */
export type OwnerClient = HttpApiClient.ForApi<typeof OwnerApi>

/** The account API's typed client (billing, inbound clients, crash reports): what the Worker answers itself. */
type AccountClient = HttpApiClient.ForApi<typeof AccountApi>

/**
 * The typed owner API over one agent's own `fetch`, with what the Worker edge adds to a forwarded request: its
 * reference (`x-goblin-ref`). No cookie reaches the agent; the tests stand where the Worker's admission stood.
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

/** One account API call through `worker` (a signed-in browser, `signedIn`), as `callOwner` makes an owner one. */
export const callAccount = <A, E>(worker: AgentFetch, call: (api: AccountClient) => Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(
    HttpApiClient.make(AccountApi, { baseUrl: 'https://agent' }).pipe(
      Effect.flatMap(call),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, (input, init) => worker.fetch(new Request(input, init))),
    ),
  )

const decodeWorkspace = Schema.decodeUnknownSync(WorkspaceSnapshot)

/**
 * The workspace feed's first event, from its server-sent answer (`GET /api/workspace/events`): every conversation
 * (closed ones too), App, Topic, Persona and organizing receipt as it is now. The stream is cancelled once it is read.
 */
export async function workspaceSnapshot(response: Response): Promise<WorkspaceSnapshot> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error(`no workspace feed: ${response.status}`)
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      buffer += decoder.decode(read.value, { stream: true })
      // Only whole frames: the last part may still be arriving.
      const frame = buffer
        .split('\n\n')
        .slice(0, -1)
        .find((part) => part.startsWith('event: snapshot'))
      const data = frame === undefined ? undefined : /^data: (.*)$/mu.exec(frame)?.[1]
      if (data !== undefined) return decodeWorkspace(JSON.parse(data))
    }
  } finally {
    await reader.cancel()
  }
  throw new Error(`no workspace snapshot: ${response.status}`)
}
