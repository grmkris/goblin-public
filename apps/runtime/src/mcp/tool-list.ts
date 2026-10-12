import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Queue from 'effect/Queue'
import { type AppError, UpstreamMcp } from '../http/errors.ts'
import type { Connection, Manager } from './connections.ts'
import { mapMcpError } from './errors.ts'
import { timed } from './log.ts'
import { bounded } from './remote.ts'
import type { McpConnectionSnapshot } from './types.ts'

// A connection's live tool list (ADR 0042): its tools re-listed in place, and the `subscriptions/listen` stream that
// tells it when they change, held open only while the connection is in use.

/** Waits until `ms` have passed since the use `lastUse` reads; each use in the meantime restarts the wait. */
export const untilUnused = (lastUse: () => number, ms: number) =>
  Effect.gen(function* () {
    let now = yield* Clock.currentTimeMillis
    while (now < lastUse() + ms) {
      yield* Effect.sleep(lastUse() + ms - now)
      now = yield* Clock.currentTimeMillis
    }
  })

/** How long a stream that failed on the way waits before it is asked again; and how old a list is re-listed on use. */
const LISTEN_RETRY_MS = 60_000
const LIST_FRESH_MS = 60_000

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
 * Lists the connection's tools again and keeps them in its snapshot: one flight per connection, which lists again
 * while the server says they changed during a list. A list that fails or overflows is never kept in part; the
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
      connection.listedAt = yield* Clock.currentTimeMillis
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

/**
 * Re-lists the connection's tools each time the server says they changed, for as long as the connection is open. The
 * SDK's handler only signals; the re-list runs in a fiber of the manager's scope.
 */
export const watchTools = (manager: Manager, connection: Connection) =>
  Effect.gen(function* () {
    const changes = yield* Queue.sliding<true>(1)
    connection.client.setNotificationHandler('notifications/tools/list_changed', () => {
      Queue.offerUnsafe(changes, true)
    })
    const relist = Effect.andThen(
      Queue.take(changes),
      // expected: a failed re-list marks the connection stale, and its step is reported.
      Effect.ignore(refreshTools(manager, connection)),
    )
    connection.listen.watcher = yield* Effect.forkIn(Effect.forever(relist), manager.scope)
  })

/** Whether the connection's server announces tool changes on a listen stream (protocol 2026-07-28). */
const announcesTools = ({ snapshot }: Connection): boolean =>
  snapshot.protocolEra === 'modern' && snapshot.capabilities.tools?.listChanged === true

/**
 * What a listen request that failed means: a server that refused it (a JSON-RPC error) is not asked again on this
 * connection; one that failed on the way is asked again after a while, never on every use.
 */
const listenFailed = (connection: Connection, error: AppError) =>
  Effect.gen(function* () {
    if (error instanceof UpstreamMcp && error.reason === 'remote-rpc') connection.listen.refused = true
    else connection.listen.retryAt = (yield* Clock.currentTimeMillis) + LISTEN_RETRY_MS
  })

/**
 * The listen stream, held until the owner and the model have not used the connection for the listen idle time, or the
 * server ends it; then the next such use lists the tools first. A server that refuses the stream, or ends it
 * deliberately (it answers the listen request, as Sidequest does when the connection is revoked), is not asked again
 * on this connection.
 */
const holdStream = (manager: Manager, connection: Connection) => {
  const connectionId = connection.server.connectionId
  return Effect.gen(function* () {
    const subscription = yield* Effect.tryPromise({
      try: () => connection.client.listen({ toolsListChanged: true }, { timeout: manager.requestTimeoutMs }),
      catch: (error) => mapMcpError(error, connectionId),
    }).pipe(Effect.tapError((error) => listenFailed(connection, error)))
    // expected: closing is idempotent and only ends the stream; a close that fails leaves it to the client's close.
    const stop = Effect.promise(() => subscription.close().catch(() => undefined))
    const idle = untilUnused(() => connection.activeAt, manager.listenIdleMs)
    const unused = Effect.as(Effect.andThen(idle, stop), 'local' as const)
    const ended = yield* Effect.raceFirst(
      Effect.promise(() => subscription.closed),
      unused,
    ).pipe(Effect.onInterrupt(() => stop))
    if (ended === 'graceful') connection.listen.refused = true
    if (ended === 'remote') {
      connection.listen.retryAt = (yield* Clock.currentTimeMillis) + LISTEN_RETRY_MS
      return yield* new UpstreamMcp({ connectionId, reason: 'transport' })
    }
  }).pipe(
    timed({ step: 'listen', connectionId }, manager.options.report),
    Effect.ensuring(
      Effect.sync(() => {
        connection.listen.held = false
        connection.listen.stream = undefined
        connection.listen.relist = true
      }),
    ),
    // expected: a stream that fails or drops is reported by its step; the next use lists the tools and listens again.
    Effect.ignore,
  )
}

/**
 * On each use of a 2026 connection by the owner or the model: listens again if no stream is held and the server
 * announces tool changes, listing the tools first when a stream closed since they were last listed, so a change made
 * while nothing listened is not missed. A connection that cannot listen (the server announces nothing, refused a
 * stream, or one failed a moment ago) lists its tools again when the list is over a minute old.
 */
export const listenWhileUsed = (manager: Manager, connection: Connection): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { listen } = connection
    if (listen.held || connection.snapshot.protocolEra !== 'modern') return
    const now = yield* Clock.currentTimeMillis
    const claimed = yield* Effect.sync(() => {
      if (listen.held || listen.refused || listen.retryAt > now || !announcesTools(connection)) return false
      listen.held = true
      return true
    })
    if (!claimed) {
      // expected: a failed re-list marks the connection stale and is reported; this use goes on with what it has.
      if (now - connection.listedAt > LIST_FRESH_MS) yield* Effect.ignore(refreshTools(manager, connection))
      return
    }
    if (listen.relist) {
      listen.relist = false
      // expected: a failed re-list marks the connection stale and is reported; this use goes on with what it has.
      yield* Effect.ignore(refreshTools(manager, connection))
    }
    listen.stream = yield* Effect.forkIn(holdStream(manager, connection), manager.scope)
  })

/** Stops the connection's stream and its re-lists, before its client closes. */
export const stopListening = ({ listen }: Connection) =>
  Effect.gen(function* () {
    if (listen.stream !== undefined) yield* Fiber.interrupt(listen.stream)
    if (listen.watcher !== undefined) yield* Fiber.interrupt(listen.watcher)
  })
