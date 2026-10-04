import type {
  AuthProvider,
  CallToolResult,
  GetPromptResult,
  ListPromptsResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
  RequestOptions,
  ServerCapabilities,
  Tool,
} from '@modelcontextprotocol/client'
import type { McpServerConfig } from '@purrable/contracts'
import type { Grant } from './grants.ts'
export type { McpServerConfig }
export type McpCaller = 'model' | 'app' | 'human'
export type McpConnectionSnapshot = {
  readonly config: McpServerConfig
  readonly protocolVersion?: string
  readonly protocolEra?: 'modern' | 'legacy'
  readonly serverInfo?: { readonly name: string; readonly version: string }
  readonly capabilities: ServerCapabilities
  readonly tools: readonly Tool[]
  readonly resources: ListResourcesResult['resources']
  readonly resourceTemplates: ListResourceTemplatesResult['resourceTemplates']
  readonly prompts: ListPromptsResult['prompts']
  readonly instructions?: string
}
export type McpManagerOptions = {
  readonly servers: readonly McpServerConfig[]
  /** The owner's exact grants; checked before any connection is opened for a call. */
  readonly allows: (grant: Grant) => boolean
  /** Bearer token source per server, with refresh on 401 (mcp/host.ts). */
  readonly auth: (server: McpServerConfig) => AuthProvider
  readonly fetch: typeof fetch
  readonly maxPages?: number
  readonly timeoutMs?: number
  /** Maximum encoded size of any one remote result or discovery page. */
  readonly maxResultBytes?: number
  /** HTML app bundles are host-only; ordinary resources and model results retain maxResultBytes. */
  readonly maxAppResourceBytes?: number
  /** Close a connection this long after its last use (default 5 minutes). */
  readonly idleMs?: number
}
export type McpCallOptions = RequestOptions & { readonly caller?: McpCaller }
export type McpToolResult = CallToolResult
export type McpPromptResult = GetPromptResult
