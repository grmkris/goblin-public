import { auth, type AuthProvider, discoverOAuthServerInfo, type Tool } from '@modelcontextprotocol/client'
import type { ServerView, ToolView } from '@purrable/contracts'
import { nowSeconds } from '../clock.ts'
import { Internal, InvalidInput, NeedsAuthorization, NotFound } from '../http/errors.ts'
import { McpConnectionManager, toolAppResource, toolOffered } from './connection.ts'
import type { Credentials } from './credentials.ts'
import type { Grant, Grants } from './grants.ts'
import { StoredOAuthProvider } from './oauth-provider.ts'
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

export type McpHostOptions = {
  readonly servers: readonly McpServerConfig[]
  readonly credentials: Credentials
  readonly grants: Grants
  readonly appUrl: string
  readonly fetch: typeof fetch
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
  readonly #refreshing = new Map<string, Promise<void>>()
  readonly #refreshedAt = new Map<string, number>()

  constructor(options: McpHostOptions) {
    this.#credentials = options.credentials
    this.#grants = options.grants
    this.#appUrl = options.appUrl
    this.#fetch = options.fetch
    this.manager = new McpConnectionManager({
      servers: options.servers,
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
    return this.manager.servers.map((server) => {
      const name = this.manager.snapshot(server.serverId)?.serverInfo?.name
      return {
        serverId: server.serverId,
        endpoint: server.endpoint,
        status: this.#credentials.status(server.serverId),
        live: this.manager.snapshot(server.serverId) !== undefined,
        ...(name === undefined ? {} : { serverName: name }),
      }
    })
  }

  /** Start (or silently renew) authorization. Returns the URL to send the owner's browser to, when one is needed. */
  async beginConnect(serverId: string): Promise<{ readonly authorizationUrl?: string }> {
    const server = this.manager.server(serverId)
    await this.manager.close(serverId)
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
