import { type AuthProvider, type FetchLike, auth } from '@modelcontextprotocol/client'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import { epochSeconds } from '../clock.ts'
import { type AppError, NeedsAuthorization, attempt } from '../http/errors.ts'
import { SingleFlight } from '../observability/single-flight.ts'
import { promiseWith } from '../runtime/boundary.ts'
import type { Credentials } from './credentials.ts'
import { isOAuthRejection, mapMcpError } from './errors.ts'
import { StoredOAuthProvider } from './oauth-provider.ts'
import type { McpServerConfig } from './types.ts'

/** Refresh this many seconds before the access token's recorded expiry. */
const REFRESH_SKEW_SECONDS = 60
/** A refresh asked for this soon after one completed is for a request that raced it: it retries with the new token. */
const RECENT_REFRESH_MS = 10_000

/** The "token" of a server that needs no sign-in: empty, so no Authorization header is sent. */
export const OPEN_ACCESS = { access_token: '', token_type: 'none' } as const

export type McpAuthOptions = {
  readonly credentials: Credentials
  readonly appUrl: string
  readonly fetch: typeof fetch
}

/**
 * The bearer tokens the SDK sends to each server, from the encrypted credentials, refreshed when they near expiry or a
 * server answers 401. A refresh is one flight per server (`mcp.refresh:<server>`), because refresh tokens rotate:
 * callers join the refresh in flight, one that finds its stale token already replaced does nothing, and only an OAuth
 * rejection marks the server `needs_auth`. The SDK calls `token` and `onUnauthorized` as Promises.
 */
export const mcpAuth = Effect.fnUntraced(function* ({ credentials, appUrl, fetch: fetcher }: McpAuthOptions) {
  const flights = yield* SingleFlight
  /** When each server's last refresh completed, in Clock milliseconds. */
  const refreshedAt = new Map<string, number>()
  const tokens = (serverId: string) => attempt(() => credentials.tokens(serverId))

  /** The OAuth refresh itself: the SDK's `auth` over the stored credentials, its network failures kept apart. */
  const exchange = (server: McpServerConfig) =>
    Effect.gen(function* () {
      const serverId = server.serverId
      // Whether every request of this refresh got an answer the server meant (no network failure, no 5xx).
      let reached = true
      const fetchFn: FetchLike = async (input, init) => {
        try {
          const response = await fetcher(input, init)
          if (response.status >= 500) reached = false
          return response
        } catch (error) {
          reached = false
          throw error
        }
      }
      const provider = new StoredOAuthProvider(credentials, serverId, appUrl, {
        kind: 'background',
        reached: () => reached,
      })
      // A refresh the authorization server could not be reached for keeps the credentials: the next call tries again.
      // A rejection means the owner signs in again.
      const result = yield* Effect.tryPromise({
        try: () => auth(provider, { serverUrl: server.endpoint, fetchFn }),
        catch: (error) =>
          isOAuthRejection(error) ? new NeedsAuthorization({ serverId }) : mapMcpError(error, serverId),
      }).pipe(
        Effect.tapErrorTag('NeedsAuthorization', () =>
          Effect.flatMap(epochSeconds, (now) => Effect.sync(() => credentials.markNeedsAuth(serverId, now))),
        ),
      )
      if (result !== 'AUTHORIZED') return yield* new NeedsAuthorization({ serverId })
      refreshedAt.set(serverId, yield* Clock.currentTimeMillis)
    })

  /**
   * The one refresh of `server` in flight. Nothing when one completed moments ago (the refused request raced it and
   * retries with the new token), or when another refresh already replaced `stale`.
   */
  const refresh = (server: McpServerConfig, stale: string | undefined) =>
    flights.run(
      `mcp.refresh:${server.serverId}`,
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        if (now - (refreshedAt.get(server.serverId) ?? Number.NEGATIVE_INFINITY) < RECENT_REFRESH_MS) return
        const current = yield* tokens(server.serverId)
        if (current !== undefined && current.access_token !== stale) return
        yield* exchange(server)
      }),
    )

  const accessToken = (server: McpServerConfig): Effect.Effect<string, AppError> =>
    Effect.gen(function* () {
      const serverId = server.serverId
      const current = yield* tokens(serverId)
      if (current === undefined) return yield* new NeedsAuthorization({ serverId })
      const expiresAt = credentials.tokenExpiresAt(serverId)
      if (expiresAt === undefined || expiresAt - REFRESH_SKEW_SECONDS > (yield* epochSeconds) || !current.refresh_token)
        return current.access_token
      yield* refresh(server, current.access_token)
      const fresh = yield* tokens(serverId)
      if (fresh === undefined) return yield* new NeedsAuthorization({ serverId })
      return fresh.access_token
    })

  const unauthorized = (server: McpServerConfig): Effect.Effect<void, AppError> =>
    Effect.gen(function* () {
      const serverId = server.serverId
      const stale = (yield* tokens(serverId))?.access_token
      // Connected without sign-in and now refused: it wants sign-in. Nothing to refresh; the owner connects.
      if (stale === OPEN_ACCESS.access_token) {
        const now = yield* epochSeconds
        yield* Effect.sync(() => credentials.markNeedsAuth(serverId, now))
        return yield* new NeedsAuthorization({ serverId })
      }
      yield* refresh(server, stale)
    })

  // Each SDK callback runs its Effect to a Promise that rejects with the typed failure itself.
  const toPromise = promiseWith(Context.empty())
  return (server: McpServerConfig): AuthProvider => ({
    token: () => toPromise(accessToken(server)),
    onUnauthorized: () => toPromise(unauthorized(server)),
  })
})
