import type {
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
import type { GrantStore, VerifiedMcpPrincipal } from '../auth/principal.ts'
export type { McpServerConfig }
type McpLifecycle = 'disconnected' | 'connecting' | 'ready' | 'stale' | 'closing'
export type McpConnectionSnapshot = {
  readonly config: McpServerConfig
  readonly lifecycle: McpLifecycle
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
type McpAuthState = {
  readonly issuer: string
  readonly resource: string
  readonly subject: string
  readonly scopes: readonly string[]
  readonly expiresAt?: number
}
export type McpTokenSource = {
  readonly state: McpAuthState
  readonly token: () => Promise<string>
  readonly refresh?: () => Promise<void>
}
export type McpManagerOptions = {
  readonly servers: readonly McpServerConfig[]
  readonly grants: GrantStore
  readonly tokenSource: (server: McpServerConfig, principal: VerifiedMcpPrincipal) => Promise<McpTokenSource>
  readonly fetch: typeof fetch
  readonly maxPages?: number
  readonly timeoutMs?: number
  /** Maximum encoded size of any one remote result or discovery page. */
  readonly maxResultBytes?: number
  /** HTML app bundles are host-only; ordinary resources and model results retain maxResultBytes. */
  readonly maxAppResourceBytes?: number
}
export type McpCallOptions = RequestOptions & { readonly caller?: 'model' | 'app' | 'human' }
export type McpToolResult = CallToolResult
export type McpPromptResult = GetPromptResult
