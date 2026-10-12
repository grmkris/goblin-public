import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import { requirePlan } from '../billing/gates.ts'
import { connectedFromStart } from '../onboarding/program.ts'
import { Changes } from '../runtime/changes.ts'
import { Events, McpServers, Resident } from './service.ts'
import type { Stage } from './suggested.ts'

declare module '../runtime/changes.ts' {
  interface ChangeTopics {
    /** The owner removed a connection: what was kept for it elsewhere (its sidebar pin, ADR 0053) goes too. */
    'mcp.removed': { readonly connectionId: string }
  }
}

/** The owner's servers, each with the health of its Events. */
export const ownerServers = Effect.gen(function* () {
  const servers = yield* (yield* McpServers).list()
  const events = yield* Events
  return yield* Effect.forEach(servers, (server) =>
    Effect.map(events.health(server.connectionId), (eventHealth) => ({ ...server, eventHealth })),
  )
})

/** The suggested servers the owner has not added yet. */
export const suggestedServers = (stage: Stage | undefined) => McpServers.use((servers) => servers.suggested(stage))

/** Removes a server, its Events subscriptions first, then tells the change bus it is gone. */
export const removeOwnerServer = (connectionId: string) =>
  Effect.gen(function* () {
    yield* (yield* Events).disableServer(connectionId)
    yield* (yield* McpServers).remove(connectionId)
    yield* (yield* Changes).publish('mcp.removed', { connectionId })
    return null
  })

/** Disconnects a server (its credentials go), its Events subscriptions first. */
export const disconnectOwnerServer = (connectionId: string) =>
  Effect.gen(function* () {
    yield* (yield* Events).disableServer(connectionId)
    yield* (yield* McpServers).disconnect(connectionId)
    return null
  })

/**
 * Where an outbound sign-in comes back (`GET /api/mcp/oauth/callback`, the `mcp` group's raw `oauthCallback`: it
 * answers a redirect, not JSON). The owner lands on Connections with `connected=<connectionId>`, or with `error=` and the
 * authorization server's own error, `authorization_failed` for an incomplete callback, or the tag of the failure that
 * stopped it. Finishing is an owner request: owner admission checks the plan and, as for every raw endpoint, does not
 * renew resident authority.
 */
export const connectCallback = (params: URLSearchParams, appUrl: string) =>
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
      yield* requirePlan()
      yield* Resident.use((resident) => resident.renew())
      return yield* McpServers.use((servers) => servers.finishConnect(state, code, issuer))
    })
    const finished = yield* Effect.exit(finish)
    if (Exit.isFailure(finished)) {
      const failed = Option.match(Cause.findErrorOption(finished.cause), {
        onNone: () => 'Internal',
        onSome: (e) => e._tag,
      })
      target.searchParams.set('error', failed)
      return target
    }
    // A sign-in first-run Start began goes back to its step (ADR 0048); its tools are allowed first if the owner asked.
    const step = yield* connectedFromStart(finished.value).pipe(
      // expected: a note that cannot be read sends the owner to Connections, connected all the same
      Effect.orElseSucceed(() => undefined),
    )
    const back = step === undefined ? target : new URL(`/start/${step}`, appUrl)
    back.searchParams.set('connected', finished.value)
    return back
  })
