import * as Effect from 'effect/Effect'
import { Events, McpServers } from './service.ts'
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
