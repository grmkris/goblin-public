import {
  Client,
  SdkHttpError,
  SdkErrorCode,
  ProtocolError,
  StreamableHTTPClientTransport,
  type ReadResourceResult,
  type RequestOptions,
  type Tool,
} from '@modelcontextprotocol/client'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker'
import { Clock, Effect, Predicate } from 'effect'
import { requireGrant, type VerifiedMcpPrincipal } from '../auth/principal.ts'
import { McpBoundaryError, mapMcpError } from './errors.ts'
import type {
  McpCallOptions,
  McpConnectionSnapshot,
  McpManagerOptions,
  McpTokenSource,
  McpToolResult,
  McpPromptResult,
  McpServerConfig,
} from './types.ts'

/** SDK uses the platform fetch at this external boundary; all policy is checked before acquisition/execution. */
const authorizationMatches = (server: McpServerConfig, auth: McpTokenSource): boolean =>
  auth.state.resource === (server.resource ?? server.endpoint) &&
  (server.issuer === undefined || auth.state.issuer === server.issuer)

type Connection = {
  readonly client: Client
  readonly transport: StreamableHTTPClientTransport
  readonly server: McpServerConfig
  readonly auth: McpTokenSource
  snapshot: McpConnectionSnapshot
}
const principalKey = (principal: VerifiedMcpPrincipal, serverId: string): string =>
  JSON.stringify([principal.issuer, principal.subject, principal.clientId, principal.tenantId ?? '', serverId])
const capabilityOffered = (tool: Tool, caller: 'model' | 'app' | 'human'): boolean => {
  const meta = tool._meta
  const ui = meta?.['ui']
  if (!Predicate.isObject(ui) || !('visibility' in ui) || !Array.isArray(ui.visibility)) return true
  if (!ui.visibility.every(Predicate.isString)) return true
  if (caller === 'human') return true
  return ui.visibility.includes(caller)
}
const optionalTemplates = async (
  client: Client,
  options: RequestOptions,
): Promise<McpConnectionSnapshot['resourceTemplates']> => {
  try {
    return (await client.listResourceTemplates(undefined, { cacheMode: 'refresh', ...options })).resourceTemplates
  } catch (error) {
    // MCP servers may advertise resources while omitting the optional templates/list method. MyPlan uses a JSON-RPC
    // method-not-found response (HTTP 404) for that case; preserve the connection and represent no templates.
    if (
      (error instanceof SdkHttpError && error.status === 404 && error.code === SdkErrorCode.ClientHttpNotImplemented) ||
      (error instanceof ProtocolError && error.code === -32601)
    )
      return []
    throw error
  }
}

export class McpConnectionManager {
  readonly #options: McpManagerOptions
  readonly #servers: ReadonlyMap<string, McpServerConfig>
  readonly #connections = new Map<string, Connection>()
  constructor(options: McpManagerOptions) {
    this.#options = options
    this.#servers = new Map(options.servers.map((server) => [server.serverId, server]))
    if (this.#servers.size !== options.servers.length) throw new Error('mcp_server_id_duplicate')
    for (const server of options.servers) {
      const url = new URL(server.endpoint)
      const localHttp = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
      if (url.protocol !== 'https:' && !localHttp) throw new Error('mcp_endpoint_not_https')
      if (url.username || url.password || url.hash) throw new Error('mcp_endpoint_invalid')
    }
  }

  async #assertPrincipalActive(principal: VerifiedMcpPrincipal): Promise<void> {
    const now = Math.floor((await Effect.runPromise(Clock.currentTimeMillis)) / 1000)
    if (principal.expiresAt <= now) throw new McpBoundaryError('unauthorized', 'principal')
  }
  #bounded<T>(serverId: string, value: T, max = this.#options.maxResultBytes ?? 1_048_576): T {
    let encoded: string
    try {
      encoded = JSON.stringify(value) ?? ''
    } catch {
      throw new McpBoundaryError('content-limit', serverId)
    }
    if (new TextEncoder().encode(encoded).byteLength > max) throw new McpBoundaryError('content-limit', serverId)
    return value
  }

  /** Fresh handshakes retain no credential-bearing metadata and don't trust serverInfo as identity. */
  async connect(
    principal: VerifiedMcpPrincipal,
    serverId: string,
    options: RequestOptions = {},
  ): Promise<McpConnectionSnapshot> {
    await this.#assertPrincipalActive(principal)
    const key = principalKey(principal, serverId)
    const existing = this.#connections.get(key)
    if (existing !== undefined) return existing.snapshot
    const server = this.#servers.get(serverId)
    if (server === undefined) throw new McpBoundaryError('unsupported', serverId)
    const auth = await this.#options.tokenSource(server, principal)
    if (!authorizationMatches(server, auth)) throw new McpBoundaryError('unauthorized', serverId)
    const now = Math.floor((await Effect.runPromise(Clock.currentTimeMillis)) / 1000)
    if (auth.state.expiresAt !== undefined && auth.state.expiresAt <= now)
      throw new McpBoundaryError('unauthorized', serverId)
    const client = new Client(
      { name: 'purrable', version: '0.1.0' },
      {
        capabilities: {},
        versionNegotiation: { mode: 'auto', probe: { timeoutMs: this.#options.timeoutMs ?? 10_000, maxRetries: 0 } },
        listMaxPages: this.#options.maxPages ?? 64,
        cachePartition: key,
        jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      },
    )
    const transport = new StreamableHTTPClientTransport(new URL(server.endpoint), {
      authProvider: { token: auth.token, ...(auth.refresh === undefined ? {} : { onUnauthorized: auth.refresh }) },
      fetch: this.#options.fetch,
    })
    try {
      await client.connect(transport, { timeout: this.#options.timeoutMs ?? 10_000, ...options })
      const protocolVersion = client.getNegotiatedProtocolVersion()
      const protocolEra = client.getProtocolEra()
      if (protocolVersion === undefined || protocolEra === undefined)
        throw new McpBoundaryError('unsupported', serverId)
      const capabilities = client.getServerCapabilities() ?? {}
      const serverInfo = client.getServerVersion()
      const instructions = client.getInstructions()
      const snapshot: McpConnectionSnapshot = {
        config: server,
        lifecycle: 'ready',
        protocolVersion,
        protocolEra,
        ...(serverInfo === undefined ? {} : { serverInfo: { name: serverInfo.name, version: serverInfo.version } }),
        ...(instructions === undefined ? {} : { instructions }),
        capabilities,
        tools: [],
        resources: [],
        resourceTemplates: [],
        prompts: [],
      }
      const connection = { client, transport, server, auth, snapshot }
      this.#connections.set(key, connection)
      return await this.#discover(connection, options)
    } catch (error) {
      this.#connections.delete(key)
      await client.close().catch(() => undefined)
      throw mapMcpError(error, serverId)
    }
  }
  async #discover(connection: Connection, options: RequestOptions): Promise<McpConnectionSnapshot> {
    const { client } = connection
    const capabilities = client.getServerCapabilities() ?? {}
    // One SDK client per principal+configured server keeps private and public caches isolated.
    const [tools, resources, templates, prompts]: [
      readonly Tool[],
      McpConnectionSnapshot['resources'],
      McpConnectionSnapshot['resourceTemplates'],
      McpConnectionSnapshot['prompts'],
    ] = await Promise.all([
      capabilities.tools === undefined
        ? Promise.resolve([])
        : client.listTools(undefined, { cacheMode: 'refresh', ...options }).then((r) => r.tools),
      capabilities.resources === undefined
        ? Promise.resolve([])
        : client.listResources(undefined, { cacheMode: 'refresh', ...options }).then((r) => r.resources),
      capabilities.resources === undefined ? Promise.resolve([]) : optionalTemplates(client, options),
      capabilities.prompts === undefined
        ? Promise.resolve([])
        : client.listPrompts(undefined, { cacheMode: 'refresh', ...options }).then((r) => r.prompts),
    ])
    connection.snapshot = this.#bounded(connection.server.serverId, {
      ...connection.snapshot,
      lifecycle: 'ready',
      tools,
      resources,
      resourceTemplates: templates,
      prompts,
    })
    return connection.snapshot
  }
  snapshot(principal: VerifiedMcpPrincipal, serverId: string): McpConnectionSnapshot | undefined {
    return this.#connections.get(principalKey(principal, serverId))?.snapshot
  }
  tools(
    principal: VerifiedMcpPrincipal,
    serverId: string,
    caller: 'model' | 'app' | 'human' = 'model',
  ): readonly Tool[] {
    return this.snapshot(principal, serverId)?.tools.filter((tool) => capabilityOffered(tool, caller)) ?? []
  }
  async close(principal: VerifiedMcpPrincipal, serverId: string): Promise<void> {
    const key = principalKey(principal, serverId)
    const connection = this.#connections.get(key)
    this.#connections.delete(key)
    if (connection !== undefined) await connection.client.close()
  }
  async reconnect(
    principal: VerifiedMcpPrincipal,
    serverId: string,
    options: RequestOptions = {},
  ): Promise<McpConnectionSnapshot> {
    await this.close(principal, serverId)
    return this.connect(principal, serverId, options)
  }
  async closeAll(): Promise<void> {
    const connections = [...this.#connections.values()]
    this.#connections.clear()
    await Promise.all(connections.map((connection) => connection.client.close()))
  }
  async #authorized(
    principal: VerifiedMcpPrincipal,
    serverId: string,
    capability: 'tool' | 'resource' | 'prompt',
    name: string,
    options: RequestOptions = {},
  ): Promise<Connection> {
    try {
      await requireGrant(this.#options.grants, principal, { serverId, capability, name })
    } catch {
      throw new McpBoundaryError('grant-denied', serverId)
    }
    const key = principalKey(principal, serverId)
    if (!this.#connections.has(key)) await this.connect(principal, serverId, options)
    const connection = this.#connections.get(key)
    if (connection === undefined) throw new McpBoundaryError('transport', serverId)
    return connection
  }
  async callTool(
    principal: VerifiedMcpPrincipal,
    serverId: string,
    name: string,
    args: Record<string, unknown> = {},
    options: McpCallOptions = {},
  ): Promise<McpToolResult> {
    const connection = await this.#authorized(principal, serverId, 'tool', name, options)
    const tool = connection.snapshot.tools.find((item) => item.name === name)
    if (tool === undefined || !capabilityOffered(tool, options.caller ?? 'model'))
      throw new McpBoundaryError('unsupported', serverId)
    try {
      this.#bounded(serverId, args)
      return this.#bounded(
        serverId,
        await connection.client.callTool(
          { name, arguments: args },
          { timeout: this.#options.timeoutMs ?? 30_000, ...options },
        ),
      )
    } catch (error) {
      throw mapMcpError(error, serverId)
    }
  }
  async readResource(
    principal: VerifiedMcpPrincipal,
    serverId: string,
    uri: string,
    options: RequestOptions = {},
  ): Promise<ReadResourceResult> {
    return this.#readResource(principal, serverId, uri, options, this.#options.maxResultBytes ?? 1_048_576)
  }
  /** Only the authenticated Apps host may use the larger HTML bundle bound; no model result takes this path. */
  async readAppResource(
    principal: VerifiedMcpPrincipal,
    serverId: string,
    uri: string,
    options: RequestOptions = {},
  ): Promise<ReadResourceResult> {
    if (principal.authKind !== 'owner') throw new McpBoundaryError('unauthorized', serverId)
    if (!uri.startsWith('ui://')) throw new McpBoundaryError('unsupported', serverId)
    const result = await this.#readResource(
      principal,
      serverId,
      uri,
      options,
      this.#options.maxAppResourceBytes ?? 16_777_216,
    )
    const content = result.contents[0]
    if (
      result.contents.length !== 1 ||
      content === undefined ||
      content.uri !== uri ||
      !('text' in content) ||
      !/^text\/html(?:\s*;[^\r\n]*)?$/iu.test(content.mimeType ?? '')
    )
      throw new McpBoundaryError('unsupported', serverId)
    return result
  }
  async #readResource(
    principal: VerifiedMcpPrincipal,
    serverId: string,
    uri: string,
    options: RequestOptions,
    maxBytes: number,
  ): Promise<ReadResourceResult> {
    const connection = await this.#authorized(principal, serverId, 'resource', uri, options)
    if (connection.snapshot.capabilities.resources === undefined) throw new McpBoundaryError('unsupported', serverId)
    try {
      return this.#bounded(
        serverId,
        await connection.client.readResource({ uri }, { timeout: this.#options.timeoutMs ?? 30_000, ...options }),
        maxBytes,
      )
    } catch (error) {
      throw mapMcpError(error, serverId)
    }
  }
  async getPrompt(
    principal: VerifiedMcpPrincipal,
    serverId: string,
    name: string,
    args: Record<string, string> = {},
    options: RequestOptions = {},
  ): Promise<McpPromptResult> {
    const connection = await this.#authorized(principal, serverId, 'prompt', name, options)
    if (connection.snapshot.capabilities.prompts === undefined) throw new McpBoundaryError('unsupported', serverId)
    try {
      return this.#bounded(
        serverId,
        await connection.client.getPrompt(
          { name, arguments: args },
          { timeout: this.#options.timeoutMs ?? 30_000, ...options },
        ),
      )
    } catch (error) {
      throw mapMcpError(error, serverId)
    }
  }
}
