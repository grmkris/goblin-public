import { API_ERRORS, AppError } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { type AgentFetch, type InternalClient, internalCall } from '../src/inbound/client.ts'
import { type RpcResult, encodeExit } from '../src/http/rpc.ts'

const decodeEnvelope = Schema.decodeUnknownSync(Schema.Union(API_ERRORS))
const encodeError = Schema.encodeSync(AppError)

/**
 * One call of the agent's internal API through the typed client, as the Worker makes it, answered in the shape the
 * probes assert on: `{ ok: true, value }`, or `{ ok: false, error }` with the encoded failure.
 */
const internalResult = async <A, E>(
  agent: AgentFetch,
  call: (api: InternalClient) => Effect.Effect<A, E>,
): Promise<RpcResult<A>> => encodeExit(await Effect.runPromiseExit(internalCall(agent, call)))

/** An inbound client's question (`POST /internal/ask`), as /mcp's `ask_agent` asks it. */
export const askResult = (agent: AgentFetch, author: string, input: string, operationId: string, waitMs: number) =>
  internalResult(agent, (api) => api.inbound.ask({ payload: { author, input, operationId, waitMs } }))

/** Main's newest `limit` messages (`GET /internal/recent`), as /mcp's `get_recent_messages` reads them. */
export const recentResult = (agent: AgentFetch, limit: number) =>
  internalResult(agent, (api) => api.inbound.recent({ query: { limit } }))

/**
 * A POST of `body` to the internal path `path` as it is, whatever it holds (a query the client would not encode), in
 * the same shape: a success's JSON, or the failure its envelope names.
 */
async function internalPost(agent: AgentFetch, path: string, body: unknown): Promise<RpcResult<unknown>> {
  const response = await agent.fetch(
    new Request(`https://agent/internal${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  const json: unknown = await response.json()
  return response.ok ? { ok: true, value: json } : { ok: false, error: encodeError(decodeEnvelope(json)) }
}

/** One inspection query (`POST /internal/inspect`), as /mcp's tools ask it. */
export const inspectResult = (agent: AgentFetch, query: object): Promise<RpcResult<unknown>> =>
  internalPost(agent, '/inspect', { query })
