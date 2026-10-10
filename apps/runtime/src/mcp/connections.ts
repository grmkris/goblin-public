import type { Client, RequestOptions } from '@modelcontextprotocol/client'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import type * as Scope from 'effect/Scope'
import { type AppError, GrantDenied, Internal, NotFound, attemptSync } from '../http/errors.ts'
import { SingleFlight } from '../observability/single-flight.ts'
import { DispatchGuards } from './dispatch.ts'
import { mapMcpError } from './errors.ts'
import type { GrantCapability } from './grants.ts'
import { timed } from './log.ts'
import { ANSWERED, assertEndpoint, bounded, openRemote } from './remote.ts'
import type { McpConnections } from './service.ts'
import type { McpConnectionSnapshot, McpManagerOptions, McpRequestOptions, McpServerConfig } from './types.ts'

// The connection manager's state and its connections' lifecycle; the requests over a connection, and the manager
// itself, are in mcp/manager.ts.

export type Connection = {
  readonly client: Client
  readonly server: McpServerConfig
  readonly snapshot: McpConnectionSnapshot
  /** When it was last used, in Clock milliseconds; it closes once idle that long. */
  usedAt: number
  /** The fiber that closes it when it has been idle long enough. */
  idle: Fiber.Fiber<void> | undefined
}

/** One manager's state: its options and bounds, the servers it offers, its live connections and their guards. */
export type Manager = {
  readonly options: McpManagerOptions
  readonly flights: SingleFlight['Service']
  readonly scope: Scope.Scope
  readonly servers: Map<string, McpServerConfig>
  readonly connections: Map<string, Connection>
  readonly dispatch: DispatchGuards
  readonly openTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly maxPages: number
  readonly maxResultBytes: number
  readonly idleMs: number
}

/** The connections as the host that owns them uses them: also adding and removing the servers offered. */
export type McpManager = McpConnections['Service'] & {
  /** Starts offering a server the owner added. */
  readonly add: (server: McpServerConfig) => Effect.Effect<void, AppError>
  /** Stops offering a server and closes its connection. */
  readonly remove: (serverId: string) => Effect.Effect<void>
}

/** `value` when its JSON fits `max` bytes, else the `UpstreamMcp` the host answers for it. */
export const fits = <T>(serverId: string, value: T, max: number) => attemptSync(() => bounded(serverId, value, max))

export const serverOf = (manager: Manager, serverId: string): Effect.Effect<McpServerConfig, AppError> =>
  Effect.suspend(() => {
    const found = manager.servers.get(serverId)
    return found === undefined ? Effect.fail(new NotFound({ what: `server ${serverId}` })) : Effect.succeed(found)
  })

const closeClient = (connection: Connection) =>
  // expected: the connection is forgotten either way; a transport that fails to close has nothing left to release.
  Effect.promise(() => connection.client.close().catch(() => undefined))

export const close = (manager: Manager, serverId: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const connection = manager.connections.get(serverId)
    manager.connections.delete(serverId)
    if (connection === undefined) return
    if (connection.idle !== undefined) yield* Fiber.interrupt(connection.idle)
    yield* closeClient(connection)
  })

/** Waits until `connection` has gone unused for the idle time, then closes it unless it was replaced or closed. */
const idleClose = (manager: Manager, connection: Connection) =>
  Effect.gen(function* () {
    let now = yield* Clock.currentTimeMillis
    while (now < connection.usedAt + manager.idleMs) {
      yield* Effect.sleep(connection.usedAt + manager.idleMs - now)
      now = yield* Clock.currentTimeMillis
    }
    if (manager.connections.get(connection.server.serverId) !== connection) return
    manager.connections.delete(connection.server.serverId)
    yield* closeClient(connection)
  })

/** Opens the server's client and discovers it, then keeps the connection, closed in the scope when idle. */
const open = (manager: Manager, server: McpServerConfig, request: RequestOptions) =>
  Effect.gen(function* () {
    const { options } = manager
    const { client, snapshot } = yield* Effect.tryPromise({
      try: () =>
        openRemote(server, request, {
          auth: options.auth(server),
          fetch: (input, init) => manager.dispatch.fetch(input, init, options.fetch),
          timeoutMs: manager.openTimeoutMs,
          maxPages: manager.maxPages,
          maxResultBytes: manager.maxResultBytes,
        }),
      catch: (error) => mapMcpError(error, server.serverId),
    })
    const usedAt = yield* Clock.currentTimeMillis
    const connection: Connection = { client, server, snapshot, usedAt, idle: undefined }
    manager.connections.set(server.serverId, connection)
    connection.idle = yield* Effect.forkIn(idleClose(manager, connection), manager.scope)
    return connection
  })

/** The live connection, its idle time restarted, or one flight (`mcp.connect:<server>`) that opens it. */
export const connectionOf = (
  manager: Manager,
  serverId: string,
  request: RequestOptions,
): Effect.Effect<Connection, AppError> =>
  Effect.suspend(() => {
    const existing = manager.connections.get(serverId)
    if (existing !== undefined)
      return Effect.map(Clock.currentTimeMillis, (now) => {
        existing.usedAt = now
        return existing
      })
    return manager.flights.run(
      `mcp.connect:${serverId}`,
      Effect.flatMap(serverOf(manager, serverId), (server) => open(manager, server, request)).pipe(
        timed({ step: 'connect', serverId, sharedConnection: true }, manager.options.report),
      ),
    )
  })

/** A connection for a capability the owner granted; nothing is opened for one they did not. */
export const authorized = (
  manager: Manager,
  serverId: string,
  grant: { readonly capability: GrantCapability; readonly name: string },
  request: RequestOptions,
) =>
  Effect.gen(function* () {
    yield* serverOf(manager, serverId)
    const { capability, name } = grant
    if (name === '' || !manager.options.allows({ serverId, capability, name }))
      return yield* new GrantDenied({ serverId, name })
    return yield* connectionOf(manager, serverId, request)
  })

/** One remote request; a transport or auth failure drops the cached connection so the next call reconnects. */
export const remote = <A>(
  manager: Manager,
  connection: Connection,
  request: () => Promise<A>,
  max = manager.maxResultBytes,
) => {
  const serverId = connection.server.serverId
  return Effect.tryPromise({
    try: async () => bounded(serverId, await request(), max),
    catch: (error) => mapMcpError(error, serverId),
  }).pipe(
    Effect.tapErrorTag('UpstreamMcp', (error) => (ANSWERED.has(error.reason) ? Effect.void : close(manager, serverId))),
  )
}

export const closeAll = (manager: Manager) =>
  Effect.suspend(() =>
    Effect.forEach([...manager.connections.keys()], (serverId) => close(manager, serverId), {
      concurrency: 'unbounded',
      discard: true,
    }),
  )

/** The servers offered, the connections and their snapshots, as the service answers them. */
export const lifecycle = (manager: Manager) => ({
  servers: () => Effect.sync(() => [...manager.servers.values()]),
  server: (serverId: string) => serverOf(manager, serverId),
  snapshot: (serverId: string) => Effect.sync(() => Option.fromNullishOr(manager.connections.get(serverId)?.snapshot)),
  connect: Effect.fn('McpConnections.connect')(function* (serverId: string, options: McpRequestOptions = {}) {
    const { runContext, ...request } = options
    const opened = Effect.map(connectionOf(manager, serverId, request), (live) => live.snapshot)
    return yield* runContext === undefined
      ? opened
      : opened.pipe(timed({ step: 'connect', serverId, scope: runContext }, manager.options.report))
  }),
  reconnect: Effect.fn('McpConnections.reconnect')(function* (serverId: string) {
    yield* close(manager, serverId)
    return (yield* connectionOf(manager, serverId, {})).snapshot
  }),
  close: (serverId: string) => close(manager, serverId),
  closeAll: () => closeAll(manager),
  add: (server: McpServerConfig) =>
    attemptSync(() => {
      assertEndpoint(server)
      if (manager.servers.has(server.serverId)) throw new Internal({ reason: 'mcp_server_id_duplicate' })
      manager.servers.set(server.serverId, server)
    }),
  remove: (serverId: string) =>
    Effect.andThen(
      close(manager, serverId),
      Effect.sync(() => manager.servers.delete(serverId)),
    ),
})

/**
 * A manager's state over `options`: the configured servers, each with an https endpoint and a unique id; its
 * connections close when the scope ends.
 */
export const managerState = Effect.fnUntraced(function* (options: McpManagerOptions) {
  const servers = new Map(options.servers.map((server) => [server.serverId, server]))
  yield* attemptSync(() => {
    if (servers.size !== options.servers.length) throw new Internal({ reason: 'mcp_server_id_duplicate' })
    for (const server of options.servers) assertEndpoint(server)
  })
  const manager: Manager = {
    options,
    flights: yield* SingleFlight,
    scope: yield* Effect.scope,
    servers,
    connections: new Map(),
    dispatch: new DispatchGuards(),
    openTimeoutMs: options.timeoutMs ?? 10_000,
    requestTimeoutMs: options.timeoutMs ?? 30_000,
    maxPages: options.maxPages ?? 64,
    maxResultBytes: options.maxResultBytes ?? 1_048_576,
    idleMs: options.idleMs ?? 300_000,
  }
  yield* Effect.addFinalizer(() => closeAll(manager))
  return manager
})
