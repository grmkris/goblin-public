import type { Client, RequestOptions } from '@modelcontextprotocol/client'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import type * as Scope from 'effect/Scope'
import { type AppError, GrantDenied, Internal, NotFound, type UpstreamMcp, attemptSync } from '../http/errors.ts'
import { SingleFlight } from '../observability/single-flight.ts'
import { DispatchGuards } from './dispatch.ts'
import { mapMcpError } from './errors.ts'
import type { GrantCapability } from './grants.ts'
import { logClientError, timed } from './log.ts'
import { ANSWERED, assertEndpoint, bounded, openRemote } from './remote.ts'
import type { McpConnections } from './service.ts'
import { listenWhileUsed, refreshTools, stopListening, toolsListed, untilUnused, watchTools } from './tool-list.ts'
import type { McpConnectionSnapshot, McpManagerOptions, McpRequestOptions, McpServerConfig, McpUse } from './types.ts'

// The connection manager's state and its connections' lifecycle; the requests over a connection, and the manager
// itself, are in mcp/manager.ts.

/** A connection's listen stream for tool changes (mcp/tool-list.ts, ADR 0042), held only while it is used. */
export type ListenState = {
  /** A stream is held, or being opened. */
  held: boolean
  /** The fiber that holds it. */
  stream: Fiber.Fiber<void> | undefined
  /** The fiber that re-lists the tools on each change the server announces. */
  watcher: Fiber.Fiber<void> | undefined
  /** The server refused a stream or ended one deliberately: it is not asked again on this connection. */
  refused: boolean
  /** A stream failed on the way (the network, a timeout): not asked again before this Clock time. */
  retryAt: number
  /** A stream closed since the tools were last listed: the next use lists them first. */
  relist: boolean
}

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
  readonly listen: ListenState
  /** When it was last used by anyone, in Clock milliseconds; it closes once idle that long. */
  usedAt: number
  /** When the owner or the model last used it; its listen stream closes once that is the listen idle time ago. */
  activeAt: number
  /** Requests under way on it: it is never closed for being idle while one is. */
  inFlight: number
  /** When its tools were last listed whole. */
  listedAt: number
  /** Requests in a row that missed their deadline: one is a slow tool, two a connection that no longer answers. */
  timeouts: number
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
  /** One tool call's deadline without an answer or progress, and its deadline in all (types.ts). */
  readonly toolTimeoutMs: number
  readonly toolDeadlineMs: number
  readonly maxPages: number
  readonly maxResultBytes: number
  readonly idleMs: number
  /** How long a listen stream stays open after the connection's last use. */
  readonly listenIdleMs: number
  /** How many connections it has opened. */
  opened: number
  /** The digest of each connection's last whole tool list, to tell a change from a list that came back the same. */
  readonly digests: Map<string, string>
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
    yield* stopListening(connection)
    yield* closeClient(connection)
  })

/**
 * Waits until `connection` has gone unused for the idle time with nothing under way on it, then closes it unless it was
 * replaced or closed.
 */
const idleClose = (manager: Manager, connection: Connection) =>
  Effect.gen(function* () {
    yield* untilUnused(() => connection.usedAt, manager.idleMs)
    while (connection.inFlight > 0) {
      // A request under way stamps the connection when it ends, so the idle time starts again from then.
      yield* Effect.sleep(manager.idleMs)
      yield* untilUnused(() => connection.usedAt, manager.idleMs)
    }
    if (manager.connections.get(connection.server.connectionId) !== connection) return
    manager.connections.delete(connection.server.connectionId)
    yield* stopListening(connection)
    yield* closeClient(connection)
  })

/**
 * Opens the server's client and discovers it, then keeps the connection, closed in the scope when idle, its tools
 * re-listed whenever the server says they changed.
 */
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
      listen: { held: false, stream: undefined, watcher: undefined, refused: false, retryAt: 0, relist: false },
      usedAt,
      activeAt: 0,
      inFlight: 0,
      listedAt: usedAt,
      timeouts: 0,
      idle: undefined,
    }
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the SDK Client reports errors only through onerror.
    client.onerror = (error) => logClientError(server.connectionId, error)
    manager.connections.set(server.connectionId, connection)
    connection.idle = yield* Effect.forkIn(idleClose(manager, connection), manager.scope)
    yield* watchTools(manager, connection)
    yield* toolsListed(manager, connection)
    return connection
  })

/**
 * One use of `connection`: its idle time restarts, and a foreground use holds its listen stream. Run after the
 * connection is found or opened, so a foreground caller that joins a background caller's open still listens.
 */
const touch = (manager: Manager, connection: Connection, use: McpUse) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    connection.usedAt = now
    if (use === 'background') return
    connection.activeAt = now
    yield* listenWhileUsed(manager, connection)
  })

/**
 * The live connection, used (`touch`), or one flight (`mcp.connect:<server>`) that opens it. A stale one (its tools
 * could not be re-listed) is closed and opened again.
 */
export const connectionOf = (
  manager: Manager,
  connectionId: string,
  request: RequestOptions,
  use: McpUse = 'foreground',
): Effect.Effect<Connection, AppError> =>
  Effect.suspend(() => {
    const existing = manager.connections.get(connectionId)
    if (existing?.stale === true)
      return Effect.andThen(close(manager, connectionId), connectionOf(manager, connectionId, request, use))
    const live =
      existing === undefined
        ? manager.flights.run(
            `mcp.connect:${connectionId}`,
            Effect.flatMap(serverOf(manager, connectionId), (server) => open(manager, server, request)).pipe(
              timed({ step: 'connect', connectionId, sharedConnection: true }, manager.options.report),
            ),
          )
        : Effect.succeed(existing)
    return Effect.tap(live, (connection) => touch(manager, connection, use))
  })

/** A connection for a capability the owner granted; nothing is opened for one they did not. */
export const authorized = (
  manager: Manager,
  connectionId: string,
  grant: { readonly capability: GrantCapability; readonly name: string },
  request: RequestOptions,
  use: McpUse,
) =>
  Effect.gen(function* () {
    yield* serverOf(manager, connectionId)
    const { capability, name } = grant
    if (name === '' || !manager.options.allows({ connectionId, capability, name }))
      return yield* new GrantDenied({ connectionId, name })
    return yield* connectionOf(manager, connectionId, request, use)
  })

/** Failures after which the connection is kept: the server answered, or the caller stopped waiting. */
const KEPT: ReadonlySet<UpstreamMcp['reason']> = new Set([...ANSWERED, 'cancelled'])

/** What a failed request means for its connection: kept, or dropped so the next call reconnects. */
const afterFailure = (manager: Manager, connection: Connection, error: UpstreamMcp) => {
  if (KEPT.has(error.reason)) return Effect.void
  // One slow tool is not a broken connection; a second missed deadline in a row is.
  if (error.reason === 'timeout') {
    connection.timeouts += 1
    if (connection.timeouts < 2) return Effect.void
  }
  return close(manager, connection.server.connectionId)
}

/** One remote request; a transport or auth failure drops the cached connection so the next call reconnects. */
export const remote = <A>(
  manager: Manager,
  connection: Connection,
  request: () => Promise<A>,
  max = manager.maxResultBytes,
) => {
  const connectionId = connection.server.connectionId
  // Counted while under way, and the connection stamped used when it ends, so a long request is never closed under.
  const ended = Effect.andThen(Clock.currentTimeMillis, (now) =>
    Effect.sync(() => {
      connection.inFlight -= 1
      connection.usedAt = Math.max(connection.usedAt, now)
    }),
  )
  return Effect.sync(() => {
    connection.inFlight += 1
  }).pipe(
    Effect.andThen(
      Effect.tryPromise({
        try: async () => bounded(connectionId, await request(), max),
        catch: (error) => mapMcpError(error, connectionId),
      }),
    ),
    Effect.ensuring(ended),
    Effect.tap(() =>
      Effect.sync(() => {
        connection.timeouts = 0
      }),
    ),
    Effect.tapErrorTag('UpstreamMcp', (error) => afterFailure(manager, connection, error)),
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
    const { runContext, use, ...request } = options
    const opened = Effect.map(connectionOf(manager, connectionId, request, use), (live) => live.snapshot)
    return yield* runContext === undefined
      ? opened
      : opened.pipe(timed({ step: 'connect', connectionId, scope: runContext }, manager.options.report))
  }),
  refreshTools: Effect.fn('McpConnections.refreshTools')(function* (
    connectionId: string,
    options: McpRequestOptions = {},
  ) {
    const { runContext: _, use, ...request } = options
    return yield* refreshTools(manager, yield* connectionOf(manager, connectionId, request, use))
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
    toolTimeoutMs: options.toolTimeoutMs ?? 90_000,
    toolDeadlineMs: options.toolDeadlineMs ?? 300_000,
    maxPages: options.maxPages ?? 64,
    maxResultBytes: options.maxResultBytes ?? 1_048_576,
    idleMs: options.idleMs ?? 300_000,
    listenIdleMs: options.listenIdleMs ?? 60_000,
    opened: 0,
    digests: new Map(),
  }
  yield* Effect.addFinalizer(() => closeAll(manager))
  return manager
})
