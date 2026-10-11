import {
  type AuthProvider,
  Client,
  ProtocolError,
  type RequestOptions,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  type Tool,
} from '@modelcontextprotocol/client'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker'
import { Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { Internal, UpstreamMcp } from '../http/errors.ts'
import { readBytes } from '../http/body.ts'
import { SKILLS_EXTENSION } from '../skills/protocol.ts'
import { EVENTS_EXTENSION } from './events/protocol.ts'
import type { McpCaller, McpConnectionSnapshot, McpServerConfig } from './types.ts'

// What one remote server is to the manager (mcp/manager.ts): the official SDK client it opens over the server's
// endpoint, the snapshot discovered through it, and the pure reads of that snapshot the host and tools use.

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

/** `value` when its JSON fits `max` bytes; otherwise the `UpstreamMcp` the host answers for it. */
export function bounded<T>(connectionId: string, value: T, max: number): T {
  const size = encodedSize(value)
  if (size === undefined) throw new UpstreamMcp({ connectionId, reason: 'unsupported' })
  if (size > max) throw new UpstreamMcp({ connectionId, reason: 'content-limit' })
  return value
}

/** Failures the server answered over a working connection, which is kept: a JSON-RPC error, or a result refused here. */
export const ANSWERED: ReadonlySet<UpstreamMcp['reason']> = new Set(['remote-rpc', 'content-limit', 'unsupported'])

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

/**
 * A server offers Events by either spelling of the draft: the top-level `capabilities.events` its first producers (and
 * ChatGPT) use, or the `io.modelcontextprotocol/events` extension of SEP-3415.
 */
export const offersEvents = (snapshot: McpConnectionSnapshot): boolean =>
  snapshot.capabilities.events !== undefined || snapshot.capabilities.extensions?.[EVENTS_EXTENSION] !== undefined

/** The `ui://` resource a tool renders into, when it declares one. */
export const toolAppResource = (tool: Tool): string | undefined => {
  const ui = tool._meta?.['ui']
  if (!Predicate.isObject(ui) || !('resourceUri' in ui) || !Predicate.isString(ui.resourceUri)) return undefined
  return ui.resourceUri.startsWith('ui://') ? ui.resourceUri : undefined
}

/** A server's endpoint is https (or plain http on this machine), with no credentials or fragment in it. */
export function assertEndpoint(server: McpServerConfig): void {
  const url = new URL(server.endpoint)
  const localHttp = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  if (url.protocol !== 'https:' && !localHttp) throw new Internal({ reason: 'mcp_endpoint_not_https' })
  if (url.username || url.password || url.hash) throw new Internal({ reason: 'mcp_endpoint_invalid' })
}

const RawDiscovery = Schema.Struct({
  result: Schema.Struct({
    capabilities: Schema.Struct({ events: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) }),
  }),
})

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

/** How a client is opened: the server's bearer tokens, the guarded fetch, and the bounds of discovery. */
export type OpenOptions = {
  readonly auth: AuthProvider
  readonly fetch: (input: RequestInfo | URL, init: RequestInit | undefined) => Promise<Response>
  readonly timeoutMs: number
  readonly maxPages: number
  readonly maxResultBytes: number
}

/** Every list the server declares, refreshed; the whole snapshot bounded as one result. */
async function discover(
  client: Client,
  snapshot: McpConnectionSnapshot,
  options: RequestOptions,
  maxResultBytes: number,
): Promise<McpConnectionSnapshot> {
  const capabilities = snapshot.capabilities
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
  return bounded(
    snapshot.config.connectionId,
    { ...snapshot, tools, resources, resourceTemplates, prompts },
    maxResultBytes,
  )
}

/**
 * Opens the official SDK client for `server` and discovers what it offers. A client that fails to open is closed
 * before the failure goes on, as the SDK threw it.
 */
export async function openRemote(
  server: McpServerConfig,
  request: RequestOptions,
  options: OpenOptions,
): Promise<{ readonly client: Client; readonly snapshot: McpConnectionSnapshot }> {
  const client = new Client(
    { name: 'goblin', version: '0.1.0' },
    {
      capabilities: { extensions: { [SKILLS_EXTENSION]: {}, [EVENTS_EXTENSION]: {} } },
      versionNegotiation: { mode: 'auto', probe: { timeoutMs: options.timeoutMs, maxRetries: 0 } },
      listMaxPages: options.maxPages,
      cachePartition: server.connectionId,
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    },
  )
  let events: Record<string, unknown> | undefined
  const transport = new StreamableHTTPClientTransport(new URL(server.endpoint), {
    authProvider: options.auth,
    // The pinned SDK strips draft top-level capabilities. Decode the authenticated discovery response
    // at its supported fetch seam; never make a second unauthenticated discovery request.
    fetch: async (input, init) => {
      const response = await options.fetch(input, init)
      if (
        typeof init?.body === 'string' &&
        /"method":"(?:server\/discover|initialize)"/u.test(init.body) &&
        response.ok &&
        response.headers.get('content-type')?.includes('application/json')
      ) {
        const raw = await readBytes(response.clone(), 16 * 1024 * 1024)
        try {
          events = Schema.decodeUnknownSync(RawDiscovery)(JSON.parse(new TextDecoder().decode(raw))).result.capabilities
            .events
        } catch {
          // expected: ordinary legacy discovery has no draft capability to decode.
        }
      }
      return response
    },
  })
  try {
    await client.connect(transport, { timeout: options.timeoutMs, ...request })
    const protocolVersion = client.getNegotiatedProtocolVersion()
    const protocolEra = client.getProtocolEra()
    if (protocolVersion === undefined || protocolEra === undefined)
      throw new UpstreamMcp({ connectionId: server.connectionId, reason: 'unsupported' })
    const serverInfo = client.getServerVersion()
    const instructions = client.getInstructions()
    const opened: McpConnectionSnapshot = {
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
    }
    return { client, snapshot: await discover(client, opened, request, options.maxResultBytes) }
  } catch (error) {
    // expected: the client failed to open; closing what it holds must not hide that failure.
    await client.close().catch(() => undefined)
    throw error
  }
}
