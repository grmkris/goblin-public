import * as Effect from 'effect/Effect'
import { Mcp, attempt } from '../services.ts'
import { Events } from './events.ts'
import { type Stage, suggestions } from './suggested.ts'

/** The owner's servers, each with the health of its Events. */
export const ownerServers = Effect.gen(function* () {
  const mcp = yield* Mcp
  const events = yield* Events
  return mcp.servers().map((server) => ({ ...server, eventHealth: events.health(server.serverId) }))
})

/** The suggested servers the owner has not added yet. */
export const suggestedServers = (stage: Stage | undefined) =>
  Mcp.useSync((mcp) => suggestions(stage, new Set(mcp.manager.servers.map((server) => server.endpoint))))

/** Removes a server, its Events subscriptions first. */
export const removeOwnerServer = (serverId: string) =>
  Effect.gen(function* () {
    yield* (yield* Events).disableServer(serverId)
    return yield* Mcp.use((mcp) => attempt(async () => (await mcp.removeServer(serverId), null)))
  })

/** Disconnects a server (its credentials go), its Events subscriptions first. */
export const disconnectOwnerServer = (serverId: string) =>
  Effect.gen(function* () {
    yield* (yield* Events).disableServer(serverId)
    return yield* Mcp.use((mcp) => attempt(async () => (await mcp.disconnect(serverId), null)))
  })
