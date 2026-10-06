import type { CallToolResult, GetPromptResult, ReadResourceResult } from '@modelcontextprotocol/client'
import type { PiReceipt } from 'agents/harness/pi'
import type { RpcResult } from './http/rpc.ts'
import type { Grant, GrantCapability } from './mcp/grants.ts'
import type {
  AppCall,
  AppCallResult,
  AppContext,
  AppDiagnostic,
  AppLaunch,
  AppPower,
  AppPowerChange,
  AppSnapshot,
  AppView,
  CreateApp,
  UpdateApp,
  CapabilityChange,
  CatalogEntry,
  ChannelStatus,
  ConversationCapabilities,
  MemoryStatus,
  ModelChoice,
  RegistryView,
  ResidentStatus,
  ServerSuggestion,
  ServerView,
  ConversationView,
  CreateConversation,
  UpdateConversation,
  ToolView,
  UsageToday,
} from '@goblin/contracts'
import type { TranscriptMessage } from './pi/transcript.ts'
import type { MailBinding } from './auth/mail.ts'
import type { ServerSource } from './mcp/servers.ts'
import type { EventWebhook, EventWebhookResult } from './mcp/events.ts'
import type { Doorbell } from './channel/doorbell.ts'

/** Owner-facing RPC of the Agent DO. The Worker authenticates the owner before calling any of these. */
export interface AgentRpcMethods {
  readonly submit: (
    thread: string,
    input: string,
    operationId: string,
    appContext?: readonly AppContext[],
    attachments?: readonly string[],
  ) => Promise<RpcResult<PiReceipt>>
  readonly stop: (thread: string, operationId?: string) => Promise<RpcResult<boolean>>
  readonly conversations: () => Promise<RpcResult<readonly ConversationView[]>>
  readonly createConversation: (input: CreateConversation) => Promise<RpcResult<ConversationView>>
  readonly updateConversation: (id: string, change: UpdateConversation) => Promise<RpcResult<ConversationView>>
  readonly markRead: (id: string) => Promise<RpcResult<boolean>>
  readonly createApp: (input: CreateApp) => Promise<RpcResult<AppView>>
  readonly updateApp: (id: string, change: UpdateApp) => Promise<RpcResult<AppView>>
  readonly launchApp: (id: string) => Promise<RpcResult<AppLaunch>>
  readonly appSnapshot: (id: string) => Promise<RpcResult<AppSnapshot>>
  readonly appCall: (id: string, call: AppCall) => Promise<RpcResult<AppCallResult>>
  readonly appDiagnostic: (id: string, diagnostic: AppDiagnostic) => Promise<RpcResult<{ readonly kept: boolean }>>
  readonly appPowers: (name: string) => Promise<RpcResult<readonly AppPower[]>>
  readonly answerAppPower: (name: string, change: AppPowerChange) => Promise<RpcResult<readonly AppPower[]>>
  readonly conversationCapabilities: (thread: string) => Promise<RpcResult<ConversationCapabilities>>
  readonly setConversationCapability: (
    thread: string,
    change: CapabilityChange,
  ) => Promise<RpcResult<ConversationCapabilities>>
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
  readonly mcpSetSkills: (
    serverId: string,
    enabled: boolean,
  ) => Promise<RpcResult<{ readonly serverId: string; readonly enabled: boolean }>>
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
    author: string,
    input: string,
    operationId: string,
    waitMs: number,
  ) => Promise<RpcResult<AskResult>>
  readonly recentMessages: (limit: number) => Promise<RpcResult<readonly TranscriptMessage[]>>
  readonly usageToday: () => Promise<RpcResult<UsageToday>>
  readonly memoryStatus: () => Promise<RpcResult<MemoryStatus>>
  readonly modelChoice: () => Promise<RpcResult<ModelChoice>>
  readonly chooseModel: (modelId: string) => Promise<RpcResult<ModelChoice>>
  readonly channelStatus: () => Promise<RpcResult<ChannelStatus>>
  readonly channelEnable: (serverId: string) => Promise<RpcResult<ChannelStatus>>
  readonly channelDisable: () => Promise<RpcResult<null>>
  /** Not an owner request: myagent's doorbell, after the Worker checked the hook token (channel/doorbell.ts). */
  readonly channelDoorbell: (doorbell: Doorbell) => Promise<RpcResult<true>>
  readonly mcpEventsWebhook: (input: EventWebhook) => Promise<RpcResult<EventWebhookResult>>
  readonly deleteAgentData: () => Promise<RpcResult<true>>
  readonly routines: () => Promise<RpcResult<import('@goblin/contracts').RoutinePage>>
  readonly routinePropose: (
    input: import('@goblin/contracts').RoutineProposal,
  ) => Promise<RpcResult<import('@goblin/contracts').RoutineView>>
  readonly routineEdit: (
    id: string,
    input: import('@goblin/contracts').RoutineEdit,
  ) => Promise<RpcResult<import('@goblin/contracts').RoutineView>>
  readonly routineChange: (
    id: string,
    input: import('@goblin/contracts').RoutineRevision,
    action: 'confirm' | 'pause' | 'archive',
  ) => Promise<RpcResult<import('@goblin/contracts').RoutineView>>
  readonly routineSettings: () => Promise<RpcResult<import('@goblin/contracts').RoutineSettings>>
  readonly routineSettingsSet: (
    settings: import('@goblin/contracts').RoutineSettings,
  ) => Promise<RpcResult<import('@goblin/contracts').RoutineSettings>>
  readonly routineRun: (
    id: string,
    input: import('@goblin/contracts').RoutineManualRun,
  ) => Promise<RpcResult<import('@goblin/contracts').RoutineRunView>>
  readonly routineRuns: (id: string) => Promise<RpcResult<import('@goblin/contracts').RoutineRunPage>>
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
  /** The owner's larger files (over 128 KiB), under `agents/<user>/` (ADR 0022). */
  readonly FILES: R2Bucket
  /** Dynamic Workers: every agent app release, the app transpiler and `code_run` scripts run in one (ADR 0021). */
  readonly LOADER: WorkerLoader
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
  /** The cheapest offered model, for thread titles and main's memory (`models.ts` `memoryModelId`). */
  readonly MEMORY_MODEL?: string
  /** Native fixture allowance only; deployed accounts use their plan or account override. */
  readonly MODEL_DAILY_TOKENS?: string
  /** JSON object of model id to price multiplier; omitted models count at one. */
  readonly MODEL_TOKEN_WEIGHTS?: string
  /** JSON list of outbound MCP servers: `[{ serverId, endpoint, issuer?, resource? }]`. */
  readonly MCP_SERVERS?: string
  /** 32 random bytes, base64: encrypts outbound OAuth credentials at rest. */
  readonly CREDENTIAL_KEY: string
  readonly STAGE?: 'local' | 'dev' | 'prod' | 'test'
  readonly DODO_PAYMENTS_API_KEY?: string
  readonly DODO_PAYMENTS_WEBHOOK_KEY?: string
  readonly DODO_PAYMENTS_ENVIRONMENT?: 'test_mode' | 'live_mode'
  readonly DODO_PRODUCT_ID?: string
}
