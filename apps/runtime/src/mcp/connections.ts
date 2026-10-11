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
  /** This connection among every one the manager opened: its re-lists are one flight, never another's. */
  readonly serial: number
  /** What it discovered, its tools replaced in place by each whole re-list (ADR 0042). */
  snapshot: McpConnectionSnapshot
  /** The server said its tools changed (or a call missed one) since the last re-list began. */
  toolsChanged: boolean
  /** A re-list failed, so its tools are not known: the next use opens it again. */
  stale: boolean
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
  /** How many connections it has opened. */
  opened: number
}

/** The connections as the host that owns them uses them: also adding and removing the servers offered. */
export type McpManager = McpConnections['Service'] & {
  /** Starts offering a server the owner added. */
  readonly add: (server: McpServerConfig) => Effect.Effect<void, AppError>
  /** Stops offering a server and closes its connection. */
  readonly remove: (connectionId: string) => Effect.Effect<void>
}

/** `value` when its JSON fits `max` bytes, else the `UpstreamMcp` the host answers for it. */
export const fits = <T>(connectionId: string, value: T, max: number) =>
  attemptSync(() => bounded(connectionId, value, max))

export const serverOf = (manager: Manager, connectionId: string): Effect.Effect<McpServerConfig, AppError> =>
  Effect.suspend(() => {
    const found = manager.servers.get(connectionId)
    return found === undefined ? Effect.fail(new NotFound({ what: `server ${connectionId}` })) : Effect.succeed(found)
  })

const closeClient = (connection: Connection) =>
  // expected: the connection is forgotten either way; a transport that fails to close has nothing left to release.
  Effect.promise(() => connection.client.close().catch(() => undefined))

export const close = (manager: Manager, connectionId: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const connection = manager.connections.get(connectionId)
    manager.connections.delete(connectionId)
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
    if (manager.connections.get(connection.server.connectionId) !== connection) return
    manager.connections.delete(connection.server.connectionId)
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
      catch: (error) => mapMcpError(error, server.connectionId),
    })
    const usedAt = yield* Clock.currentTimeMillis
    manager.opened += 1
    const serial = manager.opened
    const connection: Connection = {
      client,
      server,
      serial,
      snapshot,
      toolsChanged: false,
      stale: false,
      usedAt,
      idle: undefined,
    }
    manager.connections.set(server.connectionId, connection)
    connection.idle = yield* Effect.forkIn(idleClose(manager, connection), manager.scope)
    return connection
  })

/**
 * The live connection, its idle time restarted, or one flight (`mcp.connect:<server>`) that opens it. A stale one (its
 * tools could not be re-listed) is closed and opened again.
 */
export const connectionOf = (
  manager: Manager,
  connectionId: string,
  request: RequestOptions,
): Effect.Effect<Connection, AppError> =>
  Effect.suspend(() => {
    const existing = manager.connections.get(connectionId)
    if (existing?.stale === true)
      return Effect.andThen(close(manager, connectionId), connectionOf(manager, connectionId, request))
    if (existing !== undefined)
      return Effect.map(Clock.currentTimeMillis, (now) => {
        existing.usedAt = now
        return existing
      })
    return manager.flights.run(
      `mcp.connect:${connectionId}`,
      Effect.flatMap(serverOf(manager, connectionId), (server) => open(manager, server, request)).pipe(
        timed({ step: 'connect', connectionId, sharedConnection: true }, manager.options.report),
      ),
    )
  })

/** One whole list of the connection's tools, bounded as discovery is: the snapshot with those tools. */
const listTools = (manager: Manager, connection: Connection) => {
  const connectionId = connection.server.connectionId
  return Effect.tryPromise({
    try: async () => {
      const options = { cacheMode: 'refresh' as const, timeout: manager.requestTimeoutMs }
      const { tools } = await connection.client.listTools(undefined, options)
      return bounded(connectionId, { ...connection.snapshot, tools }, manager.maxResultBytes)
    },
    catch: (error) => mapMcpError(error, connectionId),
  })
}

/**
 * Lists the connection's tools again and keeps them in its snapshot (ADR 0042): one flight per connection, which lists
 * again while the server says they changed during a list. A list that fails or overflows is never kept in part; the
 * connection is marked stale instead, so its next use opens it again.
 */
export const refreshTools = (
  manager: Manager,
  connection: Connection,
): Effect.Effect<McpConnectionSnapshot, AppError> =>
  Effect.suspend(() => {
    const connectionId = connection.server.connectionId
    if (connection.snapshot.capabilities.tools === undefined) return Effect.succeed(connection.snapshot)
    connection.toolsChanged = true
    const relist = Effect.gen(function* () {
      while (connection.toolsChanged) {
        connection.toolsChanged = false
        connection.snapshot = yield* listTools(manager, connection)
      }
      return connection.snapshot
    }).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          connection.stale = true
        }),
      ),
      timed({ step: 'tools', connectionId }, manager.options.report),
    )
    return manager.flights.run(`mcp.tools:${String(connection.serial)}`, relist)
  })

/** A connection for a capability the owner granted; nothing is opened for one they did not. */
export const authorized = (
  manager: Manager,
  connectionId: string,
  grant: { readonly capability: GrantCapability; readonly name: string },
  request: RequestOptions,
) =>
  Effect.gen(function* () {
    yield* serverOf(manager, connectionId)
    const { capability, name } = grant
    if (name === '' || !manager.options.allows({ connectionId, capability, name }))
      return yield* new GrantDenied({ connectionId, name })
    return yield* connectionOf(manager, connectionId, request)
  })

/** One remote request; a transport or auth failure drops the cached connection so the next call reconnects. */
export const remote = <A>(
  manager: Manager,
  connection: Connection,
  request: () => Promise<A>,
  max = manager.maxResultBytes,
) => {
  const connectionId = connection.server.connectionId
  return Effect.tryPromise({
    try: async () => bounded(connectionId, await request(), max),
    catch: (error) => mapMcpError(error, connectionId),
  }).pipe(
    Effect.tapErrorTag('UpstreamMcp', (error) =>
      ANSWERED.has(error.reason) ? Effect.void : close(manager, connectionId),
    ),
  )
}

/** Closes every connection: the manager's finalizer, when the agent's runtime goes. */
const closeAll = (manager: Manager) =>
  Effect.suspend(() =>
    Effect.forEach([...manager.connections.keys()], (connectionId) => close(manager, connectionId), {
      concurrency: 'unbounded',
      discard: true,
    }),
  )

/** The servers offered, the connections and their snapshots, as the service answers them. */
export const lifecycle = (manager: Manager) => ({
  servers: () => Effect.sync(() => [...manager.servers.values()]),
  server: (connectionId: string) => serverOf(manager, connectionId),
  snapshot: (connectionId: string) =>
    Effect.sync(() => Option.fromNullishOr(manager.connections.get(connectionId)?.snapshot)),
  connect: Effect.fn('McpConnections.connect')(function* (connectionId: string, options: McpRequestOptions = {}) {
    const { runContext, ...request } = options
    const opened = Effect.map(connectionOf(manager, connectionId, request), (live) => live.snapshot)
    return yield* runContext === undefined
      ? opened
      : opened.pipe(timed({ step: 'connect', connectionId, scope: runContext }, manager.options.report))
  }),
  refreshTools: Effect.fn('McpConnections.refreshTools')(function* (
    connectionId: string,
    options: McpRequestOptions = {},
  ) {
    const { runContext: _, ...request } = options
    return yield* refreshTools(manager, yield* connectionOf(manager, connectionId, request))
  }),
  reconnect: Effect.fn('McpConnections.reconnect')(function* (connectionId: string) {
    yield* close(manager, connectionId)
    return (yield* connectionOf(manager, connectionId, {})).snapshot
  }),
  close: (connectionId: string) => close(manager, connectionId),
  add: (server: McpServerConfig) =>
    attemptSync(() => {
      assertEndpoint(server)
      if (manager.servers.has(server.connectionId)) throw new Internal({ reason: 'mcp_connection_id_duplicate' })
      manager.servers.set(server.connectionId, server)
    }),
  remove: (connectionId: string) =>
    Effect.andThen(
      close(manager, connectionId),
      Effect.sync(() => manager.servers.delete(connectionId)),
    ),
})

/**
 * A manager's state over `options`: the configured servers, each with an https endpoint and a unique id; its
 * connections close when the scope ends.
 */
export const managerState = Effect.fnUntraced(function* (options: McpManagerOptions) {
  const servers = new Map(options.servers.map((server) => [server.connectionId, server]))
  yield* attemptSync(() => {
    if (servers.size !== options.servers.length) throw new Internal({ reason: 'mcp_connection_id_duplicate' })
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
    opened: 0,
  }
  yield* Effect.addFinalizer(() => closeAll(manager))
  return manager
})
