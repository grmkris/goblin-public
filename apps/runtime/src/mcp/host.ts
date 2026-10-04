import { auth, type AuthProvider, discoverOAuthServerInfo, type Tool } from '@modelcontextprotocol/client'
import type { CatalogEntry, RegistryView, ServerView, ToolView } from '@purrable/contracts'
import { nowSeconds } from '../clock.ts'
import { Internal, InvalidInput, NeedsAuthorization, NotFound } from '../http/errors.ts'
import { McpConnectionManager, toolAppResource, toolOffered } from './connection.ts'
import type { Credentials } from './credentials.ts'
import type { Grant, Grants } from './grants.ts'
import { addedServerId, serverClaims, userEndpoint } from './endpoint.ts'
import { StoredOAuthProvider } from './oauth-provider.ts'
import { type AddedRegistries, MAX_ADDED_REGISTRIES } from './registries.ts'
import { DEFAULT_REGISTRIES, RegistryCatalog } from './registry.ts'
import { type AddedServers, MAX_ADDED_SERVERS, type ServerSource } from './servers.ts'
import type { McpServerConfig } from './types.ts'

/** Refresh this many seconds before the access token's recorded expiry. */
const REFRESH_SKEW_SECONDS = 60
/** A 401 this soon after a completed refresh is a request that raced it: retry with the new token instead. */
const RECENT_REFRESH_MS = 10_000

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

/** The "token" of a server that needs no sign-in: empty, so no Authorization header is sent. */
const OPEN_ACCESS = { access_token: '', token_type: 'none' } as const

export type McpHostOptions = {
  /** The deployment's servers; they win over an added server with the same id. */
  readonly servers: readonly McpServerConfig[]
  readonly credentials: Credentials
  readonly grants: Grants
  readonly appUrl: string
  readonly fetch: typeof fetch
  /** Servers the owner added; without it, the server list is fixed. */
  readonly added?: AddedServers
  /** Random characters for added server ids. */
  readonly random?: () => string
  /** Registries the owner added; without it, only the built-in ones are searched. */
  readonly registries?: AddedRegistries
}

/**
 * Outbound MCP for the resident agent: the connection manager, the encrypted OAuth credentials and the owner's grants,
 * all inside the Agent DO. Token refresh is single-flight per server because refresh tokens rotate.
 */
export class McpHost {
  readonly manager: McpConnectionManager
  readonly #credentials: Credentials
  readonly #grants: Grants
  readonly #appUrl: string
  readonly #fetch: typeof fetch
  readonly #catalog: RegistryCatalog
  readonly #registries: AddedRegistries | undefined
  readonly #configured: ReadonlySet<string>
  readonly #added: AddedServers | undefined
  readonly #random: () => string
  readonly #refreshing = new Map<string, Promise<void>>()
  readonly #refreshedAt = new Map<string, number>()

  constructor(options: McpHostOptions) {
    this.#credentials = options.credentials
    this.#grants = options.grants
    this.#appUrl = options.appUrl
    this.#fetch = options.fetch
    this.#added = options.added
    this.#catalog = new RegistryCatalog(options.fetch)
    this.#registries = options.registries
    // @effect-diagnostics-next-line cryptoRandomUUID:off -- Unguessable suffixes for added server ids.
    this.#random = options.random ?? (() => crypto.randomUUID().replaceAll('-', ''))
    this.#configured = new Set(options.servers.map((server) => server.serverId))
    const added = (options.added?.list() ?? []).filter((server) => !this.#configured.has(server.serverId))
    this.manager = new McpConnectionManager({
      servers: [...options.servers, ...added.map(({ serverId, endpoint }) => ({ serverId, endpoint }))],
      allows: (grant) => options.grants.allows(grant),
      auth: (server) => this.#authProvider(server),
      fetch: options.fetch,
    })
  }

  #authProvider(server: McpServerConfig): AuthProvider {
    return {
      token: () => this.#accessToken(server),
      onUnauthorized: async () => {
        if (Date.now() - (this.#refreshedAt.get(server.serverId) ?? 0) < RECENT_REFRESH_MS) return
        const stale = (await this.#credentials.tokens(server.serverId))?.access_token
        // Connected without sign-in and now refused: it wants sign-in. Nothing to refresh; the owner connects.
        if (stale === OPEN_ACCESS.access_token) {
          this.#credentials.markNeedsAuth(server.serverId, nowSeconds())
          throw new NeedsAuthorization({ serverId: server.serverId })
        }
        await this.#refresh(server, stale)
      },
    }
  }

  async #accessToken(server: McpServerConfig): Promise<string> {
    const serverId = server.serverId
    const tokens = await this.#credentials.tokens(serverId)
    if (tokens === undefined) throw new NeedsAuthorization({ serverId })
    const expiresAt = this.#credentials.tokenExpiresAt(serverId)
    if (expiresAt === undefined || expiresAt - REFRESH_SKEW_SECONDS > nowSeconds() || !tokens.refresh_token)
      return tokens.access_token
    await this.#refresh(server, tokens.access_token)
    const fresh = await this.#credentials.tokens(serverId)
    if (fresh === undefined) throw new NeedsAuthorization({ serverId })
    return fresh.access_token
  }

  /** Single-flight refresh. If another refresh already replaced `stale`, there is nothing to do. */
  #refresh(server: McpServerConfig, stale: string | undefined): Promise<void> {
    const serverId = server.serverId
    const running = this.#refreshing.get(serverId)
    if (running !== undefined) return running
    const refresh = (async () => {
      const current = await this.#credentials.tokens(serverId)
      if (current !== undefined && current.access_token !== stale) return
      const provider = new StoredOAuthProvider(this.#credentials, serverId, this.#appUrl, { kind: 'background' })
      let result: 'AUTHORIZED' | 'REDIRECT'
      try {
        result = await auth(provider, { serverUrl: server.endpoint, fetchFn: this.#fetch })
      } catch {
        this.#credentials.markNeedsAuth(serverId, nowSeconds())
        throw new NeedsAuthorization({ serverId })
      }
      if (result !== 'AUTHORIZED') throw new NeedsAuthorization({ serverId })
      this.#refreshedAt.set(serverId, Date.now())
    })().finally(() => this.#refreshing.delete(serverId))
    this.#refreshing.set(serverId, refresh)
    return refresh
  }

  servers(): readonly ServerView[] {
    const added = new Map((this.#added?.list() ?? []).map((server) => [server.serverId, server]))
    return this.manager.servers.map((server) => {
      const name = this.manager.snapshot(server.serverId)?.serverInfo?.name
      const claims = this.#configured.has(server.serverId) ? undefined : added.get(server.serverId)
      return {
        serverId: server.serverId,
        endpoint: server.endpoint,
        status: this.#credentials.status(server.serverId),
        live: this.manager.snapshot(server.serverId) !== undefined,
        ...(name === undefined ? {} : { serverName: name }),
        source: claims === undefined ? 'config' : 'added',
        ...(claims?.title === undefined ? {} : { title: claims.title }),
        ...(claims?.description === undefined ? {} : { description: claims.description }),
        ...(claims?.icon === undefined ? {} : { icon: claims.icon }),
      }
    })
  }

  /**
   * Add a server by its endpoint: a public https URL not already offered, labelled from its server card. It starts
   * disconnected; the owner connects it as any other. `source` records the registry entry it came from.
   */
  async addServer(raw: string, source?: ServerSource): Promise<ServerView> {
    const added = this.#added
    if (added === undefined) throw new InvalidInput({ reason: 'servers_fixed' })
    const endpoint = userEndpoint(raw)
    if (this.manager.servers.some((server) => server.endpoint === endpoint.href))
      throw new InvalidInput({ reason: 'already_added' })
    if (added.list().length >= MAX_ADDED_SERVERS) throw new InvalidInput({ reason: 'too_many_servers' })
    const claims = await serverClaims(endpoint, this.#fetch)
    const taken = new Set(this.manager.servers.map((server) => server.serverId))
    const serverId = addedServerId(endpoint, taken, this.#random)
    const server = { serverId, endpoint: endpoint.href }
    added.add({ ...server, ...claims, ...(source === undefined ? {} : { source }) }, nowSeconds())
    this.manager.add(server)
    const view = this.servers().find((item) => item.serverId === serverId)
    if (view === undefined) throw new Internal({ reason: 'added server missing' })
    return view
  }

  /** Search MCP registries for servers the owner may add, marking the ones already offered. */
  async searchCatalog(query: string): Promise<readonly CatalogEntry[]> {
    const offered = new Set(this.manager.servers.map((server) => server.endpoint))
    const entries = await this.#catalog.search(query.trim(), [
      ...DEFAULT_REGISTRIES,
      ...(this.#registries?.list() ?? []),
    ])
    return entries.map((entry) => ({ ...entry, added: offered.has(entry.endpoint) }))
  }

  /** The registries searched for servers: the built-in ones first, then the owner's. */
  registries(): readonly RegistryView[] {
    return [
      ...DEFAULT_REGISTRIES.map(({ url, title }) => ({ url, title, builtIn: true })),
      ...(this.#registries?.list() ?? []).map(({ url, title }) => ({ url, title, builtIn: false })),
    ]
  }

  /** Add a registry to search, once it answers the generic registry API. */
  async addRegistry(raw: string): Promise<readonly RegistryView[]> {
    const added = this.#registries
    if (added === undefined) throw new InvalidInput({ reason: 'registries_fixed' })
    if (added.list().length >= MAX_ADDED_REGISTRIES) throw new InvalidInput({ reason: 'too_many_registries' })
    const registry = await this.#catalog.probe(raw)
    if (this.registries().some((item) => item.url === registry.url)) throw new InvalidInput({ reason: 'already_added' })
    added.add(registry, nowSeconds())
    return this.registries()
  }

  /** Stop searching a registry the owner added; the built-in ones stay. Servers added from it stay too. */
  removeRegistry(url: string): readonly RegistryView[] {
    if (this.#registries === undefined || !this.#registries.list().some((item) => item.url === url))
      throw new InvalidInput({ reason: 'unknown_registry' })
    this.#registries.remove(url)
    return this.registries()
  }

  /** Remove a server the owner added, with its credentials, grants and pending sign-ins. Configured ones stay. */
  async removeServer(serverId: string): Promise<void> {
    const added = this.#added
    if (added === undefined || !added.list().some((server) => server.serverId === serverId))
      throw new InvalidInput({ reason: this.#configured.has(serverId) ? 'configured_server' : 'unknown_server' })
    await this.manager.remove(serverId)
    added.remove(serverId)
  }

  /** Start (or silently renew) authorization. Returns the URL to send the owner's browser to, when one is needed. */
  async beginConnect(serverId: string): Promise<{ readonly authorizationUrl?: string }> {
    const server = this.manager.server(serverId)
    await this.manager.close(serverId)
    if (await this.#connectsOpenly(server)) return {}
    const provider = new StoredOAuthProvider(this.#credentials, serverId, this.#appUrl, { kind: 'interactive' })
    const scope = await offeredScope(server.endpoint, this.#fetch)
    const result = await auth(provider, {
      serverUrl: server.endpoint,
      fetchFn: this.#fetch,
      ...(scope === undefined ? {} : { scope }),
    })
    if (result === 'AUTHORIZED') return {}
    if (provider.authorizationUrl === undefined) throw new Internal({ reason: 'authorization URL missing' })
    return { authorizationUrl: provider.authorizationUrl.href }
  }

  /**
   * Many servers need no sign-in (public documentation servers, for example), some only offer it. Try the server with
   * an empty token, which the transport leaves out: if it answers discovery, it is connected. If it refuses, the
   * OAuth flow runs. A server that later demands sign-in is marked needs_auth by the refused refresh, as any other.
   */
  async #connectsOpenly(server: McpServerConfig): Promise<boolean> {
    await this.#credentials.saveTokens(server.serverId, OPEN_ACCESS, nowSeconds())
    try {
      await this.manager.connect(server.serverId)
      return true
    } catch {
      await this.manager.close(server.serverId)
      this.#credentials.invalidate(server.serverId, 'tokens', nowSeconds())
      return false
    }
  }

  /** Complete the authorization the browser was redirected back from. The `state` is single-use. */
  async finishConnect(state: string, code: string, issuer: string | undefined): Promise<string> {
    const pending = await this.#credentials.takePending(state, nowSeconds())
    if (pending === undefined) throw new InvalidInput({ reason: 'unknown or expired authorization state' })
    const server = this.manager.server(pending.serverId)
    const provider = new StoredOAuthProvider(this.#credentials, server.serverId, this.#appUrl, {
      kind: 'callback',
      codeVerifier: pending.codeVerifier,
    })
    const result = await auth(provider, {
      serverUrl: server.endpoint,
      authorizationCode: code,
      ...(issuer === undefined ? {} : { iss: issuer }),
      fetchFn: this.#fetch,
    })
    if (result !== 'AUTHORIZED') throw new NeedsAuthorization({ serverId: server.serverId })
    return server.serverId
  }

  /** Forget the server's credentials and close its connection. Grants stay, so a reconnect keeps them. */
  async disconnect(serverId: string): Promise<void> {
    this.manager.server(serverId)
    await this.manager.close(serverId)
    this.#credentials.remove(serverId)
  }

  async tools(serverId: string, refresh: boolean): Promise<readonly ToolView[]> {
    const snapshot = refresh ? await this.manager.reconnect(serverId) : await this.manager.connect(serverId)
    return snapshot.tools.map((tool) => this.#toolView(serverId, tool))
  }

  #toolView(serverId: string, tool: Tool): ToolView {
    const appResource = toolAppResource(tool)
    return {
      name: tool.name,
      ...(tool.title === undefined ? {} : { title: tool.title }),
      ...(tool.description === undefined ? {} : { description: tool.description }),
      ...(tool.annotations?.readOnlyHint === undefined ? {} : { readOnlyHint: tool.annotations.readOnlyHint }),
      ...(tool.annotations?.destructiveHint === undefined ? {} : { destructiveHint: tool.annotations.destructiveHint }),
      modelVisible: toolOffered(tool, 'model'),
      ...(appResource === undefined ? {} : { appResource }),
      granted: this.#grants.allows({ serverId, capability: 'tool', name: tool.name }),
    }
  }

  grants(): readonly Grant[] {
    return this.#grants.list()
  }

  /**
   * Grant or revoke an App as a whole: exactly the discovered tools that declare `uri` as their App (including the
   * ones only the App may call), and the App resource itself. Nothing else on the server changes.
   */
  async setAppGrant(serverId: string, uri: string, allowed: boolean): Promise<readonly Grant[]> {
    const snapshot = await this.manager.connect(serverId)
    const tools = snapshot.tools.filter((tool) => toolAppResource(tool) === uri)
    if (tools.length === 0) throw new NotFound({ what: `app ${uri}` })
    const now = nowSeconds()
    for (const tool of tools) this.#grants.set({ serverId, capability: 'tool', name: tool.name }, allowed, now)
    this.#grants.set({ serverId, capability: 'resource', name: uri }, allowed, now)
    return this.#grants.list()
  }

  /** Grant or revoke one discovered tool. Its `ui://` App resource follows the tools that use it. */
  async setToolGrant(serverId: string, name: string, allowed: boolean): Promise<readonly Grant[]> {
    const snapshot = await this.manager.connect(serverId)
    const tool = snapshot.tools.find((item) => item.name === name)
    if (tool === undefined) throw new NotFound({ what: `tool ${name}` })
    const now = nowSeconds()
    this.#grants.set({ serverId, capability: 'tool', name }, allowed, now)
    const appResource = toolAppResource(tool)
    if (appResource !== undefined) {
      const stillUsed = snapshot.tools.some(
        (other) =>
          toolAppResource(other) === appResource &&
          this.#grants.allows({ serverId, capability: 'tool', name: other.name }),
      )
      this.#grants.set({ serverId, capability: 'resource', name: appResource }, stillUsed, now)
    }
    return this.#grants.list()
  }
}
