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
import { Predicate } from 'effect'
import { GrantDenied, NotFound, UpstreamMcp } from '../http/errors.ts'
import { mapMcpError } from './errors.ts'
import { timed } from './log.ts'
import type { GrantCapability } from './grants.ts'
import type {
  McpCallOptions,
  McpCaller,
  McpConnectionSnapshot,
  McpManagerOptions,
  McpToolResult,
  McpPromptResult,
  McpServerConfig,
} from './types.ts'

type Connection = {
  readonly client: Client
  readonly server: McpServerConfig
  snapshot: McpConnectionSnapshot
  idle: ReturnType<typeof setTimeout> | undefined
}

/** MCP Apps visibility (`_meta.ui.visibility`): absent means visible to model and app; the owner sees everything. */
export const toolOffered = (tool: Tool, caller: McpCaller): boolean => {
  const ui = tool._meta?.['ui']
  if (!Predicate.isObject(ui) || !('visibility' in ui) || !Array.isArray(ui.visibility)) return true
  if (!ui.visibility.every(Predicate.isString)) return true
  if (caller === 'human') return true
  return ui.visibility.includes(caller)
}

/** The `ui://` resource a tool renders into, when it declares one. */
export const toolAppResource = (tool: Tool): string | undefined => {
  const ui = tool._meta?.['ui']
  if (!Predicate.isObject(ui) || !('resourceUri' in ui) || !Predicate.isString(ui.resourceUri)) return undefined
  return ui.resourceUri.startsWith('ui://') ? ui.resourceUri : undefined
}

const optionalTemplates = async (
  client: Client,
  options: RequestOptions,
): Promise<McpConnectionSnapshot['resourceTemplates']> => {
  try {
    return (await client.listResourceTemplates(undefined, { cacheMode: 'refresh', ...options })).resourceTemplates
  } catch (error) {
    // Servers may advertise resources while omitting the optional templates/list method; MyPlan answers with a
    // JSON-RPC method-not-found (HTTP 404). Keep the connection and report no templates.
    if (
      (error instanceof SdkHttpError && error.status === 404 && error.code === SdkErrorCode.ClientHttpNotImplemented) ||
      (error instanceof ProtocolError && error.code === -32601)
    )
      return []
    throw error
  }
}

/**
 * One cached client per configured server, owned by the Agent DO. Every call checks the owner's exact grant first;
 * results are size-bounded before they reach the host or the model. Remote metadata is data, never authority.
 */
export class McpConnectionManager {
  readonly #options: McpManagerOptions
  readonly #servers: ReadonlyMap<string, McpServerConfig>
  readonly #connections = new Map<string, Connection>()
  readonly #connecting = new Map<string, Promise<Connection>>()
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

  get servers(): readonly McpServerConfig[] {
    return [...this.#servers.values()]
  }

  server(serverId: string): McpServerConfig {
    const server = this.#servers.get(serverId)
    if (server === undefined) throw new NotFound({ what: `server ${serverId}` })
    return server
  }

  #bounded<T>(serverId: string, value: T, max = this.#options.maxResultBytes ?? 1_048_576): T {
    let encoded: string
    try {
      encoded = JSON.stringify(value) ?? ''
    } catch {
      throw new UpstreamMcp({ serverId, reason: 'content-limit' })
    }
    if (new TextEncoder().encode(encoded).byteLength > max) throw new UpstreamMcp({ serverId, reason: 'content-limit' })
    return value
  }

  #touch(connection: Connection): void {
    clearTimeout(connection.idle)
    connection.idle = setTimeout(() => void this.close(connection.server.serverId), this.#options.idleMs ?? 300_000)
  }

  /** Connect (or reuse the live connection) and return the discovered snapshot. */
  async connect(serverId: string, options: RequestOptions = {}): Promise<McpConnectionSnapshot> {
    return (await this.#connection(serverId, options)).snapshot
  }

  async #connection(serverId: string, options: RequestOptions): Promise<Connection> {
    const existing = this.#connections.get(serverId)
    if (existing !== undefined) {
      this.#touch(existing)
      return existing
    }
    const pending = this.#connecting.get(serverId)
    if (pending !== undefined) return pending
    const opening = timed({ step: 'connect', serverId }, () => this.#open(this.server(serverId), options)).finally(() =>
      this.#connecting.delete(serverId),
    )
    this.#connecting.set(serverId, opening)
    return opening
  }

  async #open(server: McpServerConfig, options: RequestOptions): Promise<Connection> {
    const client = new Client(
      { name: 'purrable', version: '0.1.0' },
      {
        capabilities: {},
        versionNegotiation: { mode: 'auto', probe: { timeoutMs: this.#options.timeoutMs ?? 10_000, maxRetries: 0 } },
        listMaxPages: this.#options.maxPages ?? 64,
        cachePartition: server.serverId,
        jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      },
    )
    const transport = new StreamableHTTPClientTransport(new URL(server.endpoint), {
      authProvider: this.#options.auth(server),
      fetch: this.#options.fetch,
    })
    try {
      await client.connect(transport, { timeout: this.#options.timeoutMs ?? 10_000, ...options })
      const protocolVersion = client.getNegotiatedProtocolVersion()
      const protocolEra = client.getProtocolEra()
      if (protocolVersion === undefined || protocolEra === undefined)
        throw new UpstreamMcp({ serverId: server.serverId, reason: 'unsupported' })
      const serverInfo = client.getServerVersion()
      const instructions = client.getInstructions()
      const connection: Connection = {
        client,
        server,
        idle: undefined,
        snapshot: {
          config: server,
          protocolVersion,
          protocolEra,
          ...(serverInfo === undefined ? {} : { serverInfo: { name: serverInfo.name, version: serverInfo.version } }),
          ...(instructions === undefined ? {} : { instructions }),
          capabilities: client.getServerCapabilities() ?? {},
          tools: [],
          resources: [],
          resourceTemplates: [],
          prompts: [],
        },
      }
      connection.snapshot = await this.#discover(connection, options)
      this.#connections.set(server.serverId, connection)
      this.#touch(connection)
      return connection
    } catch (error) {
      await client.close().catch(() => undefined)
      throw mapMcpError(error, server.serverId)
    }
  }

  async #discover(connection: Connection, options: RequestOptions): Promise<McpConnectionSnapshot> {
    const { client } = connection
    const capabilities = connection.snapshot.capabilities
    const [tools, resources, resourceTemplates, prompts] = await Promise.all([
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
    return this.#bounded(connection.server.serverId, {
      ...connection.snapshot,
      tools,
      resources,
      resourceTemplates,
      prompts,
    })
  }

  snapshot(serverId: string): McpConnectionSnapshot | undefined {
    return this.#connections.get(serverId)?.snapshot
  }

  tools(serverId: string, caller: McpCaller): readonly Tool[] {
    return this.snapshot(serverId)?.tools.filter((tool) => toolOffered(tool, caller)) ?? []
  }

  async close(serverId: string): Promise<void> {
    const connection = this.#connections.get(serverId)
    this.#connections.delete(serverId)
    if (connection === undefined) return
    clearTimeout(connection.idle)
    await connection.client.close().catch(() => undefined)
  }

  /** Drop the live connection and rediscover from a fresh handshake. */
  async reconnect(serverId: string, options: RequestOptions = {}): Promise<McpConnectionSnapshot> {
    await this.close(serverId)
    return this.connect(serverId, options)
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#connections.keys()].map((serverId) => this.close(serverId)))
  }

  async #authorized(
    serverId: string,
    capability: GrantCapability,
    name: string,
    options: RequestOptions,
  ): Promise<Connection> {
    this.server(serverId)
    if (name === '' || !this.#options.allows({ serverId, capability, name })) throw new GrantDenied({ serverId, name })
    return this.#connection(serverId, options)
  }

  /** Run one remote request; a transport or auth failure drops the cached connection so the next call reconnects. */
  async #remote<T>(connection: Connection, request: () => Promise<T>, max?: number): Promise<T> {
    const serverId = connection.server.serverId
    try {
      return this.#bounded(serverId, await request(), max)
    } catch (error) {
      const mapped = mapMcpError(error, serverId)
      if (mapped instanceof UpstreamMcp && mapped.reason !== 'remote-rpc' && mapped.reason !== 'content-limit')
        await this.close(serverId)
      throw mapped
    }
  }

  async callTool(
    serverId: string,
    name: string,
    args: Record<string, unknown> = {},
    options: McpCallOptions = {},
  ): Promise<McpToolResult> {
    const { caller = 'model', ...request } = options
    const connection = await this.#authorized(serverId, 'tool', name, request)
    const tool = connection.snapshot.tools.find((item) => item.name === name)
    if (tool === undefined || !toolOffered(tool, caller)) throw new NotFound({ what: `tool ${name}` })
    this.#bounded(serverId, args)
    return timed({ step: 'call', serverId, tool: name }, () =>
      this.#remote(connection, () =>
        connection.client.callTool(
          { name, arguments: args },
          { timeout: this.#options.timeoutMs ?? 30_000, ...request },
        ),
      ),
    )
  }

  async readResource(serverId: string, uri: string, options: RequestOptions = {}): Promise<ReadResourceResult> {
    return this.#readResource(serverId, uri, options, this.#options.maxResultBytes ?? 1_048_576)
  }

  /** Only the owner's Apps host uses the larger HTML bundle bound; no model result takes this path. */
  async readAppResource(serverId: string, uri: string, options: RequestOptions = {}): Promise<ReadResourceResult> {
    if (!uri.startsWith('ui://')) throw new UpstreamMcp({ serverId, reason: 'unsupported' })
    const result = await this.#readResource(serverId, uri, options, this.#options.maxAppResourceBytes ?? 16_777_216)
    const content = result.contents[0]
    if (
      result.contents.length !== 1 ||
      content === undefined ||
      content.uri !== uri ||
      !('text' in content) ||
      !/^text\/html(?:\s*;[^\r\n]*)?$/iu.test(content.mimeType ?? '')
    )
      throw new UpstreamMcp({ serverId, reason: 'unsupported' })
    return result
  }

  async #readResource(
    serverId: string,
    uri: string,
    options: RequestOptions,
    maxBytes: number,
  ): Promise<ReadResourceResult> {
    const connection = await this.#authorized(serverId, 'resource', uri, options)
    if (connection.snapshot.capabilities.resources === undefined)
      throw new UpstreamMcp({ serverId, reason: 'unsupported' })
    return this.#remote(
      connection,
      () => connection.client.readResource({ uri }, { timeout: this.#options.timeoutMs ?? 30_000, ...options }),
      maxBytes,
    )
  }

  async getPrompt(
    serverId: string,
    name: string,
    args: Record<string, string> = {},
    options: RequestOptions = {},
  ): Promise<McpPromptResult> {
    const connection = await this.#authorized(serverId, 'prompt', name, options)
    if (connection.snapshot.capabilities.prompts === undefined)
      throw new UpstreamMcp({ serverId, reason: 'unsupported' })
    return this.#remote(connection, () =>
      connection.client.getPrompt(
        { name, arguments: args },
        { timeout: this.#options.timeoutMs ?? 30_000, ...options },
      ),
    )
  }
}
