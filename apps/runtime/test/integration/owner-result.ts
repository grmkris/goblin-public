import * as Effect from 'effect/Effect'
import { type AgentFetch, type OwnerClient, callOwner } from './owner-api.ts'

/**
 * A typed owner API call answered in the shape the agent's RPC methods answered: `{ ok: true, value }`, or
 * `{ ok: false, error: { _tag } }` for the failure it decoded. Native assertions written against those results read
 * the API's answers unchanged.
 */
export const ownerResult = <A, E extends { readonly _tag: string }>(
  agent: AgentFetch,
  call: (api: OwnerClient) => Effect.Effect<A, E>,
) =>
  callOwner(agent, (api) =>
    call(api).pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      // expected: the failure is the answer here, as an RPC method's encoded failure was.
      Effect.catch((error) => Effect.succeed({ ok: false as const, error: { _tag: error._tag } })),
    ),
  )
