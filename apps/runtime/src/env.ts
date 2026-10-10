import type { PiReceipt } from 'agents/harness/pi'
import type { RpcResult } from './http/rpc.ts'
import type { ConversationView } from '@goblin/contracts'
import type { TranscriptMessage } from './pi/transcript.ts'
import type { MailBinding } from './auth/mail.ts'
import type { EventWebhook, EventWebhookResult } from './mcp/events.ts'
import type { Doorbell } from './channel/doorbell.ts'

/** What starting a Thread returns (ADR 0034): the Thread as it is now and the receipt of the owner's message in it. */
export type StartedThread = { readonly thread: ConversationView; readonly receipt: PiReceipt }

/**
 * The Agent DO's RPC, what is left of it: the owner reaches the agent through its typed API (`onRequest`, forwarded by
 * the Worker's edge), never through RPC. These serve the Worker's other callers, each after its own check: an inbound
 * MCP client (`/mcp`), myagent's doorbell and MCP Events (`/hooks/*`, by route token), and account erasure.
 */
export interface AgentRpcMethods {
  readonly askAsClient: (
    author: string,
    input: string,
    operationId: string,
    waitMs: number,
  ) => Promise<RpcResult<AskResult>>
  readonly recentMessages: (limit: number) => Promise<RpcResult<readonly TranscriptMessage[]>>
  /** Not an owner request: myagent's doorbell, after the Worker checked the hook token (channel/doorbell.ts). */
  readonly channelDoorbell: (doorbell: Doorbell) => Promise<RpcResult<true>>
  readonly mcpEventsWebhook: (input: EventWebhook) => Promise<RpcResult<EventWebhookResult>>
  readonly deleteAgentData: () => Promise<RpcResult<true>>
}
export type AskResult =
  | { readonly status: 'done'; readonly operationId: string; readonly text: string }
  | { readonly status: 'running'; readonly operationId: string }
  | { readonly status: 'unanswered'; readonly operationId: string; readonly reason: string }
export type AgentRpc = AgentRpcMethods & Rpc.DurableObjectBranded

export interface RuntimeEnv {
  readonly AGENTS: DurableObjectNamespace<AgentRpc>
  readonly AUTH_DB: D1Database
  /** The owner's larger files (over 128 KiB), under `agents/<user>/` (ADR 0022). */
  readonly FILES: R2Bucket
  readonly FLOWS?: AnalyticsEngineDataset
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
  /** Native fixture only: tokens main runs past its memory view before a new one (`memory.ts` `FOLD_TOKENS`). */
  readonly MEMORY_FOLD_TOKENS?: string
  /**
   * JSON `{ default?, models?, aliases? }` of tokens per estimated Token Plan Credit by model (`budget-credits.ts`);
   * unset, Alibaba's example rates apply to every model.
   */
  readonly MODEL_CREDIT_RATES?: string
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
