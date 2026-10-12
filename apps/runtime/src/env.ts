import type { RpcResult } from './http/rpc.ts'
import type { MailBinding } from './auth/mail.ts'
import type { DecisionsBinding } from './decisions/client.ts'

/**
 * The Agent DO's RPC, what is left of it: account erasure. The owner reaches the agent through its typed API and the
 * Worker's other callers (an inbound MCP client, myagent's doorbell, MCP Events) through the internal one, both over
 * `fetch` (`onRequest`, `http/api/server.ts`).
 */
export interface AgentRpcMethods {
  readonly deleteAgentData: () => Promise<RpcResult<true>>
}
export type AgentRpc = AgentRpcMethods & Rpc.DurableObjectBranded

export interface RuntimeEnv {
  readonly AGENTS: DurableObjectNamespace<AgentRpc>
  readonly AUTH_DB: D1Database
  /** The owner's larger files (over 128 KiB), under `agents/<user>/` (ADR 0022). */
  readonly FILES: R2Bucket
  readonly FLOWS?: AnalyticsEngineDataset
  /** Dynamic Workers: every agent app release, the app transpiler and `code_run` scripts run in one (ADR 0021). */
  readonly LOADER: WorkerLoader
  /** Workers AI, for typed decisions through Clef alone (ADR 0031); only the dev stage binds it. */
  readonly AI?: DecisionsBinding
  readonly APP_URL: string
  readonly BETTER_AUTH_SECRET: string
  /** Cloudflare Email Sending; with `MAIL_SENDER` it turns on email verification (`auth/mail.ts`). */
  readonly MAIL?: MailBinding
  readonly MAIL_SENDER?: string
  /** `open`, `invite` (needs `SIGNUP_INVITE_CODE`) or `closed`; anything else counts as `closed`. */
  readonly SIGNUP_MODE?: string
  readonly SIGNUP_INVITE_CODE?: string
  /**
   * The free plan's daily model Credits for an account without Pro (ADR 0026); unset or 0, there is no free plan and
   * such an account must subscribe.
   */
  readonly FREE_DAILY_CREDITS?: string
  /**
   * The routes of inference paid per call from the owner's Goblin Wallet a deployment offers (ADR 0047):
   * comma-separated `tempo` (Tempo's MPP proxy) and `goblin` (this deployment's own paid endpoint).
   */
  readonly PAID_INFERENCE?: string
  /** Who goblin's own paid endpoint is paid to (`paid:goblin`, ADR 0047): a Tempo address. */
  readonly MPP_RECIPIENT?: string
  /** The secret goblin's paid endpoint signs its MPP challenges with: at least 32 characters. */
  readonly MPP_SECRET?: string
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
  /** JSON list of outbound MCP servers every account has: `[{ connectionId, endpoint, label?, issuer?, resource? }]`. */
  readonly MCP_SERVERS?: string
  /** 32 random bytes, base64: encrypts outbound OAuth credentials at rest. */
  readonly CREDENTIAL_KEY: string
  readonly STAGE?: 'local' | 'dev' | 'prod' | 'test'
  readonly DODO_PAYMENTS_API_KEY?: string
  readonly DODO_PAYMENTS_WEBHOOK_KEY?: string
  readonly DODO_PAYMENTS_ENVIRONMENT?: 'test_mode' | 'live_mode'
  readonly DODO_PRODUCT_ID?: string
}
