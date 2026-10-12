import { auth, computeScopeUnion, discoverOAuthServerInfo, type Tool } from '@modelcontextprotocol/client'
import type { ServerSource, ServerView, ToolView } from '@goblin/contracts'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { epochSeconds } from '../clock.ts'
import {
  Conflict,
  Internal,
  InvalidInput,
  NeedsAuthorization,
  UpstreamMcp,
  attempt,
  attemptSync,
} from '../http/errors.ts'
import { OPEN_ACCESS } from './auth.ts'
import type { McpManager } from './connections.ts'
import type { Credentials } from './credentials.ts'
import { addedConnectionId, serverClaims, userEndpoint } from './endpoint.ts'
import type { Grants } from './grants.ts'
import type { EventOffers, SettledOffer } from './events/offers.ts'
import type { Labels } from './labels.ts'
import { StoredOAuthProvider } from './oauth-provider.ts'
import type { AddedRegistries } from './registries.ts'
import { profileOf, profileView } from './first-class.ts'
import { makeCatalog } from './registry.ts'
import { globalEntrypoint, offersEvents, offersSkills, toolAppResource, toolOffered } from './remote.ts'
import { type AddedServer, type AddedServers, MAX_ADDED_SERVERS } from './servers.ts'
import { McpServers } from './service.ts'
import { type Stage, suggestions } from './suggested.ts'
import type { McpConnectionSnapshot, McpServerConfig } from './types.ts'

/** The failures that mean a server was not reached at all, rather than that it refused this agent. */
const UNREACHABLE: ReadonlySet<UpstreamMcp['reason']> = new Set(['transport', 'timeout', 'cancelled'])

/**
 * Request every scope the server offers: the resource's own list, else its authorization server's. The SDK only
 * falls back to the resource's list, so a server that publishes scopes on the authorization server alone would get
 * no scope request, and with it no `offline_access` and no refresh token. Grants, not scopes, limit what runs.
 */
export const offeredScope = async (endpoint: string, fetchFn: typeof fetch): Promise<string | undefined> => {
  const info = await discoverOAuthServerInfo(endpoint, { fetchFn })
  const scopes = info.resourceMetadata?.scopes_supported ?? info.authorizationServerMetadata?.scopes_supported ?? []
  return scopes.length === 0 ? undefined : scopes.join(' ')
}

/** What goblin asks for at sign-in: every scope the server offers, and those its first-class profile adds. */
const signInScope = async (endpoint: string, fetchFn: typeof fetch): Promise<string | undefined> =>
  computeScopeUnion(await offeredScope(endpoint, fetchFn), profileOf(endpoint)?.scope?.join(' '))

/** A scope string's tokens, each once. */
const tokensOf = (scope: string | undefined): string[] => [...new Set((scope ?? '').split(' ').filter((t) => t !== ''))]

/** `offline_access`, when the server offers it: a narrower sign-in still keeps its refresh token. */
const refreshOf = (offered: string | undefined): string | undefined =>
  tokensOf(offered).includes('offline_access') ? 'offline_access' : undefined

/**
 * The scope for a sign-in the owner chose access for: the chosen tokens and `offline_access`, refused unless the
 * server offers each of them.
 */
const chosenScope = (owner: OwnerServers, endpoint: string, chosen: readonly string[]) =>
  Effect.gen(function* () {
    const offered = yield* attempt(() => signInScope(endpoint, owner.fetch))
    const known = new Set(tokensOf(offered))
    if (chosen.length === 0 || chosen.some((token) => !known.has(token)))
      return yield* new InvalidInput({ reason: 'scope_not_offered' })
    return computeScopeUnion(chosen.join(' '), refreshOf(offered))
  })

/** What the owner's servers are kept and signed in with. */
export type OwnerServers = {
  readonly manager: McpManager
  /** The deployment's servers, by id; they win over an added server with the same id. */
  readonly configured: ReadonlySet<string>
  readonly credentials: Credentials
  readonly grants: Grants
  readonly appUrl: string
  readonly fetch: typeof fetch
  readonly registries: AddedRegistries
  /** Servers the owner added; without it, the server list is fixed. */
  readonly added?: AddedServers
  /** The owner's name for every connection. */
  readonly labels: Labels
  /** What the owner did with each connection's offer of events (ADR 0041); without it, every offer stays open. */
  readonly offers?: EventOffers
  /** Random characters for added server ids. */
  readonly random: () => string
  readonly skillsEnabled: (connectionId: string) => boolean
}

const viewOf = (
  owner: OwnerServers,
  server: McpServerConfig,
  snapshot: McpConnectionSnapshot | undefined,
  claims: AddedServer | undefined,
): ServerView => {
  const name = snapshot?.serverInfo?.name
  const events = snapshot !== undefined && offersEvents(snapshot)
  const offer = events ? (owner.offers?.settled(server.connectionId) ?? 'open') : undefined
  const profile = profileOf(server.endpoint)
  const entrypoint = profile?.app?.tool ?? (snapshot === undefined ? undefined : globalEntrypoint(snapshot))
  return {
    connectionId: server.connectionId,
    label: owner.labels.of(server.connectionId) ?? server.connectionId,
    endpoint: server.endpoint,
    status: owner.credentials.status(server.connectionId),
    live: snapshot !== undefined,
    skillsOffered: snapshot !== undefined && offersSkills(snapshot),
    ...(offer === undefined ? {} : { events: offer }),
    skillsEnabled: owner.skillsEnabled(server.connectionId),
    ...(name === undefined ? {} : { serverName: name }),
    source: claims === undefined ? 'config' : 'added',
    ...(claims?.title === undefined ? {} : { title: claims.title }),
    ...(claims?.description === undefined ? {} : { description: claims.description }),
    ...(claims?.icon === undefined ? {} : { icon: claims.icon }),
    ...(profile === undefined ? {} : { profile: profileView(profile) }),
    ...(entrypoint === undefined ? {} : { entrypoint }),
  }
}

/** Every server offered, configured first, with its connection status and the claims of an added one. */
const views = (owner: OwnerServers) =>
  Effect.gen(function* () {
    const claimed = new Map((owner.added?.list() ?? []).map((server) => [server.connectionId, server]))
    const offered: ServerView[] = []
    for (const server of yield* owner.manager.servers()) {
      const snapshot = Option.getOrUndefined(yield* owner.manager.snapshot(server.connectionId))
      const claims = owner.configured.has(server.connectionId) ? undefined : claimed.get(server.connectionId)
      offered.push(viewOf(owner, server, snapshot, claims))
    }
    return offered
  })

/**
 * Adds a connection to a public https endpoint, one the owner may already have a connection to (ADR 0041). It is
 * named `label`, refused when another connection holds it, or else the first free name from its server card's title.
 * It starts disconnected; the owner connects it as any other. `source` records the registry entry it came from.
 */
const addServer = (owner: OwnerServers, raw: string, label: string | undefined, source: ServerSource | undefined) =>
  Effect.gen(function* () {
    const { added, labels, manager } = owner
    if (added === undefined) return yield* new InvalidInput({ reason: 'servers_fixed' })
    const endpoint = yield* attemptSync(() => userEndpoint(raw))
    if (added.list().length >= MAX_ADDED_SERVERS) return yield* new InvalidInput({ reason: 'too_many_servers' })
    if (label !== undefined && labels.free(label) !== label) return yield* new Conflict({ reason: 'label_taken' })
    const claims = yield* attempt(() => serverClaims(endpoint, owner.fetch))
    const taken = new Set((yield* manager.servers()).map((server) => server.connectionId))
    const server = { connectionId: addedConnectionId(endpoint, taken, owner.random), endpoint: endpoint.href }
    const now = yield* epochSeconds
    yield* attemptSync(() => {
      added.add({ ...server, ...claims, ...(source === undefined ? {} : { source }) }, now)
      labels.set(server.connectionId, label ?? labels.free(claims.title ?? endpoint.hostname))
    })
    yield* manager.add(server)
    const view = (yield* views(owner)).find((item) => item.connectionId === server.connectionId)
    if (view === undefined) return yield* new Internal({ reason: 'added server missing' })
    return view
  })

/** Removes a server the owner added, with its credentials, grants and pending sign-ins. Configured ones stay. */
const removeServer = (owner: OwnerServers, connectionId: string) =>
  Effect.gen(function* () {
    const { added } = owner
    if (added === undefined || !added.list().some((server) => server.connectionId === connectionId))
      return yield* new InvalidInput({
        reason: owner.configured.has(connectionId) ? 'configured_server' : 'unknown_server',
      })
    yield* owner.manager.remove(connectionId)
    yield* attemptSync(() => added.remove(connectionId))
    yield* Effect.sync(() => owner.offers?.remove(connectionId))
  })

/**
 * Many servers need no sign-in (public documentation servers, for example), some only offer it. Try the server with
 * an empty token, which the transport leaves out: if it answers discovery, it is connected. If it refuses, the OAuth
 * flow runs. A server that cannot be reached is that failure: no sign-in is started for it. A server that later
 * demands sign-in is marked needs_auth by the refused refresh, as any other.
 */
const connectsOpenly = (owner: OwnerServers, connectionId: string) =>
  Effect.gen(function* () {
    const { credentials, manager } = owner
    const now = yield* epochSeconds
    yield* attempt(() => credentials.saveTokens(connectionId, OPEN_ACCESS, now))
    const refused = Effect.andThen(
      manager.close(connectionId),
      Effect.flatMap(epochSeconds, (later) => Effect.sync(() => credentials.invalidate(connectionId, 'tokens', later))),
    )
    return yield* manager.connect(connectionId).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.andThen(
          refused,
          error instanceof UpstreamMcp && UNREACHABLE.has(error.reason) ? Effect.fail(error) : Effect.succeed(false),
        ),
      ),
    )
  })

/**
 * The name goblin registers itself under with a connection's authorization server, so its consent screen says which
 * connection is signing in: two connections to one server are told apart only by their labels.
 */
const clientName = (owner: OwnerServers, connectionId: string): string =>
  `goblin · ${owner.labels.of(connectionId) ?? connectionId}`

/**
 * Starts (or silently renews) authorization: the URL to send the owner's browser to, when one is needed. With `chosen`,
 * the sign-in asks for those scopes only (ADR 0042), checked against what the server offers before anything changes.
 */
const beginConnect = (owner: OwnerServers, connectionId: string, chosen?: readonly string[]) =>
  Effect.gen(function* () {
    const server = yield* owner.manager.server(connectionId)
    const narrowed = chosen === undefined ? undefined : yield* chosenScope(owner, server.endpoint, chosen)
    yield* owner.manager.close(connectionId)
    if (yield* connectsOpenly(owner, connectionId)) return {}
    const provider = new StoredOAuthProvider(
      owner.credentials,
      connectionId,
      owner.appUrl,
      { kind: 'interactive' },
      clientName(owner, connectionId),
    )
    const result = yield* attempt(async () => {
      const scope = narrowed ?? (await signInScope(server.endpoint, owner.fetch))
      return auth(provider, {
        serverUrl: server.endpoint,
        fetchFn: owner.fetch,
        ...(scope === undefined ? {} : { scope }),
      })
    })
    if (result === 'AUTHORIZED') return {}
    if (provider.authorizationUrl === undefined) return yield* new Internal({ reason: 'authorization URL missing' })
    return { authorizationUrl: provider.authorizationUrl.href }
  })

/**
 * Starts signing a connection in again with more access (ADR 0042), after a call answered 403 `insufficient_scope`:
 * a fresh authorization, never a refresh, for what the connection holds and what the server asked for (and a refresh
 * token), so access the owner chose to leave out stays out; when the held scope is not known, for everything offered. The connection and its tokens stay as they are until the new ones arrive, so an abandoned step-up leaves
 * it working as before.
 */
const beginStepUp = (owner: OwnerServers, connectionId: string, required: string) =>
  Effect.gen(function* () {
    const server = yield* owner.manager.server(connectionId)
    const provider = new StoredOAuthProvider(
      owner.credentials,
      connectionId,
      owner.appUrl,
      { kind: 'interactive' },
      clientName(owner, connectionId),
    )
    const result = yield* attempt(async () => {
      const held = await owner.credentials.tokens(connectionId)
      const offered = await signInScope(server.endpoint, owner.fetch)
      const scope =
        held?.scope === undefined
          ? computeScopeUnion(offered, required)
          : computeScopeUnion(held.scope, required, refreshOf(offered))
      return auth(provider, {
        serverUrl: server.endpoint,
        fetchFn: owner.fetch,
        forceReauthorization: true,
        ...(scope === undefined ? {} : { scope }),
      })
    })
    if (result === 'AUTHORIZED') return {}
    if (provider.authorizationUrl === undefined) return yield* new Internal({ reason: 'authorization URL missing' })
    return { authorizationUrl: provider.authorizationUrl.href }
  })

/**
 * Completes the authorization the browser was redirected back from. The `state` is single-use. The connection opens
 * again with the new tokens, so a step-up's wider access lists the tools it brings.
 */
const finishConnect = (owner: OwnerServers, state: string, code: string, issuer: string | undefined) =>
  Effect.gen(function* () {
    const now = yield* epochSeconds
    const pending = yield* attempt(() => owner.credentials.takePending(state, now))
    if (pending === undefined) return yield* new InvalidInput({ reason: 'unknown or expired authorization state' })
    const server = yield* owner.manager.server(pending.connectionId)
    const provider = new StoredOAuthProvider(
      owner.credentials,
      server.connectionId,
      owner.appUrl,
      { kind: 'callback', codeVerifier: pending.codeVerifier },
      clientName(owner, server.connectionId),
    )
    const result = yield* attempt(() =>
      auth(provider, {
        serverUrl: server.endpoint,
        authorizationCode: code,
        ...(issuer === undefined ? {} : { iss: issuer }),
        fetchFn: owner.fetch,
      }),
    )
    if (result !== 'AUTHORIZED') return yield* new NeedsAuthorization({ connectionId: server.connectionId })
    yield* owner.manager.close(server.connectionId)
    return server.connectionId
  })

/** A discovered tool as the owner sees it, with their grant and ask-first switch for it. */
export const toolView = (grants: Grants, connectionId: string, tool: Tool): ToolView => {
  const appResource = toolAppResource(tool)
  const { readOnlyHint, destructiveHint } = tool.annotations ?? {}
  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(readOnlyHint === undefined ? {} : { readOnlyHint }),
    ...(destructiveHint === undefined ? {} : { destructiveHint }),
    modelVisible: toolOffered(tool, 'model'),
    ...(appResource === undefined ? {} : { appResource }),
    granted: grants.allows({ connectionId, capability: 'tool', name: tool.name }),
    askFirst: grants.policy({ connectionId, capability: 'tool', name: tool.name })?.askFirst ?? false,
  }
}

/** The servers, their sign-in and their tools. */
const connecting = (owner: OwnerServers) => ({
  list: Effect.fn('McpServers.list')(function* () {
    return yield* views(owner)
  }),
  labels: Effect.fn('McpServers.labels')(function* () {
    return yield* Effect.sync(() => owner.labels.all())
  }),
  status: Effect.fn('McpServers.status')(function* (connectionId: string) {
    return yield* Effect.sync(() => owner.credentials.status(connectionId))
  }),
  add: Effect.fn('McpServers.add')(function* (raw: string, label?: string, source?: ServerSource) {
    return yield* addServer(owner, raw, label, source)
  }),
  rename: Effect.fn('McpServers.rename')(function* (connectionId: string, label: string) {
    yield* owner.manager.server(connectionId)
    yield* attemptSync(() => owner.labels.set(connectionId, label))
    const view = (yield* views(owner)).find((item) => item.connectionId === connectionId)
    if (view === undefined) return yield* new Internal({ reason: 'renamed connection missing' })
    return view
  }),
  remove: Effect.fn('McpServers.remove')(function* (connectionId: string) {
    yield* removeServer(owner, connectionId)
  }),
  beginConnect: Effect.fn('McpServers.beginConnect')(function* (connectionId: string, scope?: readonly string[]) {
    return yield* beginConnect(owner, connectionId, scope)
  }),
  access: Effect.fn('McpServers.access')(function* (connectionId: string) {
    const server = yield* owner.manager.server(connectionId)
    const offered = yield* attempt(() => signInScope(server.endpoint, owner.fetch))
    const held = yield* attempt(() => owner.credentials.tokens(connectionId))
    return { offered: tokensOf(offered), held: held?.scope === undefined ? null : tokensOf(held.scope) }
  }),
  beginStepUp: Effect.fn('McpServers.beginStepUp')(function* (connectionId: string, scope: string) {
    return yield* beginStepUp(owner, connectionId, scope)
  }),
  finishConnect: Effect.fn('McpServers.finishConnect')(function* (state: string, code: string, issuer?: string) {
    return yield* finishConnect(owner, state, code, issuer)
  }),
  /** Forgets the server's credentials and closes its connection. Grants stay, so a reconnect keeps them. */
  disconnect: Effect.fn('McpServers.disconnect')(function* (connectionId: string) {
    yield* owner.manager.server(connectionId)
    yield* owner.manager.close(connectionId)
    yield* Effect.sync(() => owner.credentials.remove(connectionId))
  }),
  settleEvents: Effect.fn('McpServers.settleEvents')(function* (connectionId: string, state: SettledOffer) {
    yield* owner.manager.server(connectionId)
    const at = yield* Clock.currentTimeMillis
    yield* Effect.sync(() => owner.offers?.settle(connectionId, state, at))
  }),
  tools: Effect.fn('McpServers.tools')(function* (connectionId: string, refresh: boolean) {
    // "Look for new tools" lists them again over the open connection: reconnecting would cut off calls under way.
    const snapshot = refresh
      ? yield* owner.manager.refreshTools(connectionId)
      : yield* owner.manager.connect(connectionId)
    return snapshot.tools.map((tool) => toolView(owner.grants, connectionId, tool))
  }),
})

/** The suggested servers and the registries searched for more. */
const finding = (owner: OwnerServers) => {
  const catalog = makeCatalog({ added: owner.registries, fetch: owner.fetch })
  const offered = Effect.map(owner.manager.servers(), (servers) => new Set(servers.map((server) => server.endpoint)))
  return {
    suggested: Effect.fn('McpServers.suggested')(function* (stage: Stage | undefined) {
      return suggestions(stage, yield* offered)
    }),
    catalog: Effect.fn('McpServers.catalog')(function* (query: string) {
      const { entries, partial } = yield* catalog.search(query.trim())
      const endpoints = yield* offered
      return { entries: entries.map((entry) => ({ ...entry, added: endpoints.has(entry.endpoint) })), partial }
    }),
    registries: Effect.fn('McpServers.registries')(function* () {
      return yield* catalog.registries
    }),
    addRegistry: Effect.fn('McpServers.addRegistry')(function* (url: string) {
      return yield* catalog.add(url)
    }),
    removeRegistry: Effect.fn('McpServers.removeRegistry')(function* (url: string) {
      return yield* catalog.remove(url)
    }),
  }
}

/** The owner's servers over the connections: their views, adding, removing, signing in and finding more. */
export const ownerServers = (owner: OwnerServers): McpServers['Service'] =>
  McpServers.of({ ...connecting(owner), ...finding(owner) })
