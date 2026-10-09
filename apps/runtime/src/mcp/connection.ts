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
import { Forbidden, Conflict, GrantDenied, Internal, NotFound, UpstreamMcp } from '../http/errors.ts'
import {
  SKILLS_EXTENSION,
  type SkillEntry,
  type SkillsGetResult,
  skillsGetStandard,
  skillsListStandard,
} from '../skills/protocol.ts'
import { mapMcpError } from './errors.ts'
import { DispatchGuards } from './dispatch.ts'
import { timed } from './log.ts'
import type { GrantCapability } from './grants.ts'
import * as Schema from 'effect/Schema'
import { readBytes } from '../http/body.ts'
import type {
  McpCallOptions,
  McpRequestOptions,
  SkillRequestOptions,
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

/**
 * The UTF-8 size of `value` as JSON, or undefined when it cannot be written as JSON at all (a cycle, a BigInt). That is
 * a result the host cannot carry, which is not the same as one over its size limit.
 */
export function encodedSize(value: unknown): number | undefined {
  let encoded: string
  try {
    encoded = JSON.stringify(value) ?? ''
  } catch {
    // expected: JSON.stringify throws only for what JSON cannot hold; the caller answers that as unsupported.
    return undefined
  }
  return new TextEncoder().encode(encoded).byteLength
}

/** Failures the server answered over a working connection, which is kept: a JSON-RPC error, or a result refused here. */
const ANSWERED: ReadonlySet<UpstreamMcp['reason']> = new Set(['remote-rpc', 'content-limit', 'unsupported'])

/** MCP Apps visibility (`_meta.ui.visibility`): absent means visible to model and app; the owner sees everything. */
export const toolOffered = (tool: Tool, caller: McpCaller): boolean => {
  const ui = tool._meta?.['ui']
  if (!Predicate.isObject(ui) || !('visibility' in ui) || !Array.isArray(ui.visibility)) return true
  if (!ui.visibility.every(Predicate.isString)) return true
  if (caller === 'human') return true
  return ui.visibility.includes(caller)
}

/** A server serves skills when it declares the Skills extension together with resources (files are resources). */
export const offersSkills = (snapshot: McpConnectionSnapshot): boolean =>
  snapshot.capabilities.resources !== undefined && snapshot.capabilities.extensions?.[SKILLS_EXTENSION] !== undefined

/** The selected draft uses one spelling, top-level capabilities.events. */
export const offersEvents = (snapshot: McpConnectionSnapshot): boolean => snapshot.capabilities.events !== undefined

const RawDiscovery = Schema.Struct({
  result: Schema.Struct({
    capabilities: Schema.Struct({ events: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) }),
  }),
})

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

function assertEndpoint(server: McpServerConfig): void {
  const url = new URL(server.endpoint)
  const localHttp = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  if (url.protocol !== 'https:' && !localHttp) throw new Internal({ reason: 'mcp_endpoint_not_https' })
  if (url.username || url.password || url.hash) throw new Internal({ reason: 'mcp_endpoint_invalid' })
}

/**
 * One cached client per configured server, owned by the Agent DO. Every call checks the owner's exact grant first;
 * results are size-bounded before they reach the host or the model. Remote metadata is data, never authority.
 */
export class McpConnectionManager {
  readonly #options: McpManagerOptions
  readonly #servers: Map<string, McpServerConfig>
  readonly #connections = new Map<string, Connection>()
  readonly #connecting = new Map<string, Promise<Connection>>()
  readonly #dispatch = new DispatchGuards()
  constructor(options: McpManagerOptions) {
    this.#options = options
    this.#servers = new Map(options.servers.map((server) => [server.serverId, server]))
    if (this.#servers.size !== options.servers.length) throw new Internal({ reason: 'mcp_server_id_duplicate' })
    for (const server of options.servers) assertEndpoint(server)
  }

  /** Start offering a server the owner added. */
  add(server: McpServerConfig): void {
    assertEndpoint(server)
    if (this.#servers.has(server.serverId)) throw new Internal({ reason: 'mcp_server_id_duplicate' })
    this.#servers.set(server.serverId, server)
  }

  /** Stop offering a server and close its connection. */
  async remove(serverId: string): Promise<void> {
    await this.close(serverId)
    this.#servers.delete(serverId)
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
    const size = encodedSize(value)
    if (size === undefined) throw new UpstreamMcp({ serverId, reason: 'unsupported' })
    if (size > max) throw new UpstreamMcp({ serverId, reason: 'content-limit' })
    return value
  }

  #touch(connection: Connection): void {
    clearTimeout(connection.idle)
    connection.idle = setTimeout(() => void this.close(connection.server.serverId), this.#options.idleMs ?? 300_000)
  }

  /** Connect (or reuse the live connection) and return the discovered snapshot. */
  async connect(serverId: string, options: McpRequestOptions = {}): Promise<McpConnectionSnapshot> {
    const { runContext, ...request } = options
    const connect = async () => (await this.#connection(serverId, request)).snapshot
    return runContext === undefined
      ? connect()
      : timed({ step: 'connect', serverId, scope: runContext }, connect, this.#options.report)
  }

  async #connection(serverId: string, options: RequestOptions): Promise<Connection> {
    const existing = this.#connections.get(serverId)
    if (existing !== undefined) {
      this.#touch(existing)
      return existing
    }
    const pending = this.#connecting.get(serverId)
    if (pending !== undefined) return pending
    const opening = timed(
      { step: 'connect', serverId, sharedConnection: true },
      () => this.#open(this.server(serverId), options),
      this.#options.report,
    ).finally(() => this.#connecting.delete(serverId))
    this.#connecting.set(serverId, opening)
    return opening
  }

  async #open(server: McpServerConfig, options: RequestOptions): Promise<Connection> {
    const client = new Client(
      { name: 'goblin', version: '0.1.0' },
      {
        capabilities: { extensions: { [SKILLS_EXTENSION]: {} } },
        versionNegotiation: { mode: 'auto', probe: { timeoutMs: this.#options.timeoutMs ?? 10_000, maxRetries: 0 } },
        listMaxPages: this.#options.maxPages ?? 64,
        cachePartition: server.serverId,
        jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      },
    )
    let events: Record<string, unknown> | undefined
    const transport = new StreamableHTTPClientTransport(new URL(server.endpoint), {
      authProvider: this.#options.auth(server),
      // The pinned SDK strips draft top-level capabilities. Decode the authenticated discovery response
      // at its supported fetch seam; never make a second unauthenticated discovery request.
      fetch: async (input, init) => {
        const response = await this.#dispatch.fetch(input, init, this.#options.fetch)
        if (
          typeof init?.body === 'string' &&
          /"method":"(?:server\/discover|initialize)"/u.test(init.body) &&
          response.ok &&
          response.headers.get('content-type')?.includes('application/json')
        ) {
          const raw = await readBytes(response.clone(), 16 * 1024 * 1024)
          try {
            events = Schema.decodeUnknownSync(RawDiscovery)(JSON.parse(new TextDecoder().decode(raw))).result
              .capabilities.events
          } catch {
            // expected: ordinary legacy discovery has no draft capability to decode.
          }
        }
        return response
      },
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
          capabilities: { ...client.getServerCapabilities(), ...(events === undefined ? {} : { events }) },
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
      // expected: the client failed to open; closing what it holds must not hide that failure.
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
    // expected: the connection is forgotten either way; a transport that fails to close has nothing left to release.
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
      if (mapped instanceof UpstreamMcp && !ANSWERED.has(mapped.reason)) await this.close(serverId)
      throw mapped
    }
  }

  async callTool(
    serverId: string,
    name: string,
    args: Record<string, unknown> = {},
    options: McpCallOptions = {},
  ): Promise<McpToolResult> {
    const { caller = 'model', authorize, approvalId, approvalContext, runContext, ...request } = options
    // Freeze the input before any wait; local guards and the SDK dispatch see the same object.
    const argumentsJson = JSON.stringify(args)
    const guard = async (dispatch = false) => {
      await authorize?.()
      if (!this.#options.allows({ serverId, capability: 'tool', name })) throw new GrantDenied({ serverId, name })
      // SAFETY: args is serialized once above, so this JSON object is the immutable dispatch input.
      const frozen = JSON.parse(argumentsJson) as Record<string, unknown>
      await this.#options.authorizeTool?.(
        {
          serverId,
          name,
          arguments: frozen,
          caller,
          endpoint: this.server(serverId).endpoint,
          ...(approvalContext === undefined ? {} : { approvalContext }),
        },
        approvalId,
        dispatch,
        authorize,
      )
    }
    let dispatched = false
    return timed(
      { step: 'call', serverId, tool: name, ...(runContext === undefined ? {} : { scope: runContext }) },
      async () => {
        await guard()
        const connection = await this.#authorized(serverId, 'tool', name, request)
        await guard()
        if (!this.#options.allows({ serverId, capability: 'tool', name })) throw new GrantDenied({ serverId, name })
        const tool = connection.snapshot.tools.find((item) => item.name === name)
        if (tool === undefined || !toolOffered(tool, caller)) throw new NotFound({ what: `tool ${name}` })
        this.#bounded(serverId, args)
        return this.#remote(connection, () =>
          this.#dispatch.request(
            async () => {
              if (approvalId !== undefined && dispatched)
                throw new Conflict({ reason: 'Approved MCP dispatch cannot be retried' })
              await guard(true)
              dispatched = true
              if (!this.#options.allows({ serverId, capability: 'tool', name }))
                throw new GrantDenied({ serverId, name })
            },
            { timeout: this.#options.timeoutMs ?? 30_000, ...request },
            (guarded) => {
              // SAFETY: the arguments serialized once above, parsed again so the SDK sends exactly the frozen input.
              const frozen = JSON.parse(argumentsJson) as Record<string, unknown>
              return connection.client.callTool({ name, arguments: frozen }, guarded)
            },
          ),
        )
      },
      this.#options.report,
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

  /** Draft requests use the existing connection, OAuth refresh and bounded result seam. */
  async eventRequest<S extends Schema.ConstraintDecoder<unknown>>(
    serverId: string,
    selector: { readonly name: string; readonly argumentsJson: string },
    method: 'events/list' | 'events/poll' | 'events/subscribe' | 'events/unsubscribe',
    params: Record<string, unknown>,
    schema: S,
  ): Promise<S['Type']> {
    this.server(serverId)
    if (this.#options.authorizeEvents === undefined) throw new GrantDenied({ serverId, name: selector.name })
    await this.#options.authorizeEvents(serverId, selector.name, selector.argumentsJson)
    const connection = await this.#connection(serverId, { timeout: 5000 })
    if (!offersEvents(connection.snapshot)) throw new UpstreamMcp({ serverId, reason: 'unsupported' })
    await this.#options.authorizeEvents(serverId, selector.name, selector.argumentsJson)
    return timed(
      { step: 'events', serverId, method },
      () =>
        this.#remote(
          connection,
          () => connection.client.request({ method, params }, Schema.toStandardSchemaV1(schema), { timeout: 5000 }),
          262_144,
        ),
      this.#options.report,
    )
  }

  /**
   * Every skill a server lists, when the owner uses skills from it and it declares the Skills extension. Pages are
   * followed up to the manager's page bound; the shortest `ttlMs` seen is returned for the caller's cache.
   */
  async listSkills(
    serverId: string,
    options: SkillRequestOptions = {},
  ): Promise<{ readonly skills: readonly SkillEntry[]; readonly ttlMs: number | undefined }> {
    const connection = await this.#skillsConnection(serverId, options)
    if (!offersSkills(connection.snapshot)) return { skills: [], ttlMs: undefined }
    const skills: SkillEntry[] = []
    let ttlMs: number | undefined
    let cursor: string | undefined
    for (let page = 0; page < (this.#options.maxPages ?? 64); page++) {
      const params = cursor === undefined ? {} : { cursor }
      const result = await timed(
        { step: 'skills', serverId },
        () =>
          this.#skillRequest(connection, options, (guarded) =>
            connection.client.request({ method: 'skills/list', params }, skillsListStandard, guarded),
          ),
        this.#options.report,
      )
      skills.push(...result.skills)
      if (result.ttlMs !== undefined) ttlMs = Math.min(ttlMs ?? result.ttlMs, result.ttlMs)
      if (result.nextCursor === undefined || result.nextCursor === cursor) break
      cursor = result.nextCursor
    }
    return { skills, ttlMs }
  }

  /** One skill entry by URI (`skills/get`); an unknown URI is the server's `-32602`, mapped to an upstream error. */
  async getSkill(serverId: string, uri: string, options: SkillRequestOptions = {}): Promise<SkillsGetResult> {
    const connection = await this.#skillsConnection(serverId, options)
    if (!offersSkills(connection.snapshot)) throw new UpstreamMcp({ serverId, reason: 'unsupported' })
    return this.#skillRequest(connection, options, (guarded) =>
      connection.client.request({ method: 'skills/get', params: { uri } }, skillsGetStandard, guarded),
    )
  }

  /**
   * One skill file through `resources/read`, from the server that lists the skill. The caller verifies the bytes
   * against the retained manifest (skills/verify.ts); this only bounds and fetches them.
   */
  async readSkillFile(serverId: string, uri: string, options: SkillRequestOptions = {}): Promise<ReadResourceResult> {
    const connection = await this.#skillsConnection(serverId, options)
    if (!offersSkills(connection.snapshot)) throw new UpstreamMcp({ serverId, reason: 'unsupported' })
    return this.#skillRequest(
      connection,
      options,
      (guarded) => connection.client.readResource({ uri }, guarded),
      this.#options.maxSkillFileBytes ?? 4_194_304,
    )
  }

  /** Skills are read only from servers the owner turned them on for; nothing is opened otherwise. */
  async #skillsConnection(serverId: string, options: SkillRequestOptions): Promise<Connection> {
    this.server(serverId)
    await options.authorize?.(serverId)
    if (this.#options.skillsEnabled?.(serverId) !== true)
      throw new Forbidden({ reason: `skills are not enabled for ${serverId}` })
    return this.#connection(serverId, options)
  }

  #skillRequest<T>(
    connection: Connection,
    options: SkillRequestOptions,
    send: (request: RequestOptions) => Promise<T>,
    max?: number,
  ): Promise<T> {
    const { authorize, ...request } = options
    return this.#remote(
      connection,
      () =>
        this.#dispatch.request(
          async () => {
            await authorize?.(connection.server.serverId)
            if (this.#options.skillsEnabled?.(connection.server.serverId) !== true)
              throw new Forbidden({ reason: 'skills disabled' })
          },
          { timeout: this.#options.timeoutMs ?? 30_000, ...request },
          send,
        ),
      max,
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
