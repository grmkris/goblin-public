import type { CallToolResult, GetPromptResult, ReadResourceResult } from '@modelcontextprotocol/client'
import type { PiOperationResult, PiReceipt } from 'agents/harness/pi'
import type { RpcResult } from './http/rpc.ts'
import type { Grant, GrantCapability } from './mcp/grants.ts'
import type {
  AppContext,
  CatalogEntry,
  ModelChoice,
  RegistryView,
  ResidentStatus,
  ServerSuggestion,
  ServerView,
  ToolView,
  UsageToday,
} from '@purrable/contracts'
import type { TranscriptMessage } from './pi/transcript.ts'
import type { MailBinding } from './auth/mail.ts'
import type { ServerSource } from './mcp/servers.ts'

/** Owner-facing RPC of the Agent DO. The Worker authenticates the owner before calling any of these. */
export interface AgentRpcMethods {
  readonly submit: (
    input: string,
    operationId: string,
    appContext?: readonly AppContext[],
  ) => Promise<RpcResult<PiReceipt>>
  readonly wait: (operationId: string) => Promise<RpcResult<PiOperationResult>>
  readonly stop: (operationId?: string) => Promise<RpcResult<boolean>>
  readonly mcpServers: () => Promise<RpcResult<readonly ServerView[]>>
  readonly mcpConnect: (serverId: string) => Promise<RpcResult<{ readonly authorizationUrl?: string }>>
  readonly mcpFinishConnect: (state: string, code: string, issuer?: string) => Promise<RpcResult<string>>
  readonly mcpDisconnect: (serverId: string) => Promise<RpcResult<null>>
  readonly mcpSuggested: () => Promise<RpcResult<readonly ServerSuggestion[]>>
  readonly mcpCatalog: (query: string) => Promise<RpcResult<readonly CatalogEntry[]>>
  readonly mcpRegistries: () => Promise<RpcResult<readonly RegistryView[]>>
  readonly mcpAddRegistry: (url: string) => Promise<RpcResult<readonly RegistryView[]>>
  readonly mcpRemoveRegistry: (url: string) => Promise<RpcResult<readonly RegistryView[]>>
  readonly mcpAddServer: (endpoint: string, source?: ServerSource) => Promise<RpcResult<ServerView>>
  readonly mcpRemoveServer: (serverId: string) => Promise<RpcResult<null>>
  readonly mcpTools: (serverId: string, refresh: boolean) => Promise<RpcResult<readonly ToolView[]>>
  readonly mcpGrants: () => Promise<RpcResult<readonly Grant[]>>
  readonly mcpSetToolGrant: (serverId: string, name: string, allowed: boolean) => Promise<RpcResult<readonly Grant[]>>
  readonly mcpSetAppGrant: (serverId: string, uri: string, allowed: boolean) => Promise<RpcResult<readonly Grant[]>>
  readonly mcpCallTool: (
    serverId: string,
    name: string,
    args: Record<string, unknown>,
    caller: 'human' | 'app',
  ) => Promise<RpcResult<CallToolResult>>
  readonly mcpReadResource: (
    serverId: string,
    uri: string,
    caller: 'human' | 'app',
  ) => Promise<RpcResult<ReadResourceResult>>
  readonly mcpGetPrompt: (
    serverId: string,
    name: string,
    args: Record<string, string>,
  ) => Promise<RpcResult<GetPromptResult>>
  readonly residentStatus: () => Promise<RpcResult<ResidentStatus>>
  readonly residentSet: (enabled: boolean) => Promise<RpcResult<ResidentStatus>>
  readonly askAsClient: (
    clientId: string,
    clientName: string | undefined,
    input: string,
    operationId: string,
    waitMs: number,
  ) => Promise<RpcResult<AskResult>>
  readonly clientMessages: (clientId: string, limit: number) => Promise<RpcResult<readonly TranscriptMessage[]>>
  readonly usageToday: () => Promise<RpcResult<UsageToday>>
  readonly modelChoice: () => Promise<RpcResult<ModelChoice>>
  readonly chooseModel: (modelId: string) => Promise<RpcResult<ModelChoice>>
  readonly deleteAgentData: () => Promise<RpcResult<true>>
}
export type AskResult =
  | { readonly status: 'done'; readonly operationId: string; readonly text: string }
  | { readonly status: 'running'; readonly operationId: string }
  | { readonly status: 'unanswered'; readonly operationId: string; readonly reason: string }
export type AgentRpc = AgentRpcMethods & Rpc.DurableObjectBranded
export type { GrantCapability }

export interface RuntimeEnv {
  readonly AGENTS: DurableObjectNamespace<AgentRpc>
  readonly AUTH_DB: D1Database
  readonly APP_URL: string
  readonly BETTER_AUTH_SECRET: string
  /** Cloudflare Email Sending; with `MAIL_SENDER` it turns on email verification (`auth/mail.ts`). */
  readonly MAIL?: MailBinding
  readonly MAIL_SENDER?: string
  /** `open`, `invite` (needs `SIGNUP_INVITE_CODE`) or `closed`; anything else counts as `closed`. */
  readonly SIGNUP_MODE?: string
  readonly SIGNUP_INVITE_CODE?: string
  readonly MODEL_BASE_URL: string
  /** The default model; also the first one offered. */
  readonly MODEL_ID: string
  /** More LiteLLM model names users may pick, comma-separated (`models.ts`). */
  readonly MODELS?: string
  readonly MODEL_KEY: string
  /** Model tokens each user's agent may spend per UTC day; see `budget.ts` for the default. */
  readonly MODEL_DAILY_TOKENS?: string
  /** JSON list of outbound MCP servers: `[{ serverId, endpoint, issuer?, resource? }]`. */
  readonly MCP_SERVERS?: string
  /** 32 random bytes, base64: encrypts outbound OAuth credentials at rest. */
  readonly CREDENTIAL_KEY: string
  readonly STAGE?: 'local' | 'dev' | 'test'
}
