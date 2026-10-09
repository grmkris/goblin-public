import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { Entitlements } from '../billing/gates.ts'
import { Events, McpServers, Resident } from './service.ts'
import type { Stage } from './suggested.ts'

/** The owner's servers, each with the health of its Events. */
export const ownerServers = Effect.gen(function* () {
  const servers = yield* (yield* McpServers).list()
  const events = yield* Events
  return yield* Effect.forEach(servers, (server) =>
    Effect.map(events.health(server.serverId), (eventHealth) => ({ ...server, eventHealth })),
  )
})

/** The suggested servers the owner has not added yet. */
export const suggestedServers = (stage: Stage | undefined) => McpServers.use((servers) => servers.suggested(stage))

/** Removes a server, its Events subscriptions first. */
export const removeOwnerServer = (serverId: string) =>
  Effect.gen(function* () {
    yield* (yield* Events).disableServer(serverId)
    yield* (yield* McpServers).remove(serverId)
    return null
  })

/** Disconnects a server (its credentials go), its Events subscriptions first. */
export const disconnectOwnerServer = (serverId: string) =>
  Effect.gen(function* () {
    yield* (yield* Events).disableServer(serverId)
    yield* (yield* McpServers).disconnect(serverId)
    return null
  })

/**
 * Where an outbound sign-in comes back (`GET /api/mcp/oauth/callback`, a raw route: it answers a redirect, not JSON).
 * The owner lands on Connections with `connected=<serverId>`, or with `error=` and the authorization server's own
 * error, `authorization_failed` for an incomplete callback, or the tag of the failure that stopped it. Finishing is an
 * owner request, admitted as the RPC method was: the plan, then a renewal of resident authority.
 */
export const connectCallback = (
  params: URLSearchParams,
  appUrl: string,
): Effect.Effect<URL, never, Entitlements | Resident | McpServers> =>
  Effect.gen(function* () {
    const target = new URL('/connections', appUrl)
    const state = params.get('state')
    const code = params.get('code')
    if (params.get('error') !== null || state === null || code === null) {
      target.searchParams.set('error', params.get('error') ?? 'authorization_failed')
      return target
    }
    const issuer = params.get('iss') ?? undefined
    const finish = Effect.gen(function* () {
      yield* Entitlements.use((plans) => plans.require())
      yield* Resident.use((resident) => resident.renew())
      return yield* McpServers.use((servers) => servers.finishConnect(state, code, issuer))
    })
    return yield* finish.pipe(
      Effect.matchCause({
        onSuccess: (serverId) => {
          target.searchParams.set('connected', serverId)
          return target
        },
        onFailure: (cause) => {
          const failed = Option.match(Cause.findErrorOption(cause), { onNone: () => 'Internal', onSome: (e) => e._tag })
          target.searchParams.set('error', failed)
          return target
        },
      }),
    )
  })
