import type { StepReport } from './log.ts'
import type {
  AuthProvider,
  CallToolResult,
  ListPromptsResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
  RequestOptions,
  ServerCapabilities,
  Tool,
} from '@modelcontextprotocol/client'
import type { McpServerConfig } from '@goblin/contracts'
import type * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import type { Grant } from './grants.ts'
export type { McpServerConfig }
export type McpCaller = 'model' | 'app' | 'human'
export type McpRequestOptions = RequestOptions & {
  /** Host metadata only. Strip before passing options to the remote SDK. */
  readonly runContext?: { readonly conversationId: string; readonly taskId: string }
}
export type McpConnectionSnapshot = {
  readonly config: McpServerConfig
  readonly protocolVersion?: string
  readonly protocolEra?: 'modern' | 'legacy'
  readonly serverInfo?: { readonly name: string; readonly version: string }
  readonly capabilities: ServerCapabilities & { readonly events?: Record<string, unknown> }
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
  /**
   * The owner's decision on one call, checked before it connects and again right before each dispatch (`dispatch`):
   * an ask-first tool needs its held call's approval (`approvalId`); `authorize` is the caller's own check.
   */
  readonly authorizeTool?: (
    call: ApprovedDispatch,
    approvalId: string | undefined,
    dispatch: boolean,
    authorize: Effect.Effect<void, AppError> | undefined,
  ) => Effect.Effect<void, AppError>
  /** Whether the owner uses skills from a server (skills/store.ts); checked before any skill request. */
  readonly skillsEnabled?: (connectionId: string) => boolean
  /** Bearer token source per server, with refresh on 401 (mcp/host.ts). */
  readonly auth: (server: McpServerConfig) => AuthProvider
  readonly fetch: typeof fetch
  readonly maxPages?: number
  readonly timeoutMs?: number
  /** Maximum encoded size of any one remote result or discovery page. */
  readonly maxResultBytes?: number
  /** One skill file (`readSkillFile`); default 4 MiB. Larger files stay unreadable rather than truncated. */
  readonly maxSkillFileBytes?: number
  /** HTML app bundles are host-only; ordinary resources and model results retain maxResultBytes. */
  readonly maxAppResourceBytes?: number
  /** Close a connection this long after its last use (default 5 minutes). */
  readonly idleMs?: number
  /** Where each remote step is reported (the run ledger, ADR 0024); a log line when absent. */
  readonly report?: StepReport
}
export type ApprovalContext = {
  readonly sessionId: string
  readonly sourceCallId: string
  readonly taskId: string
}
export type ApprovedDispatch = {
  readonly connectionId: string
  readonly name: string
  readonly endpoint: string
  readonly arguments: Record<string, unknown>
  readonly caller: McpCaller
  readonly approvalContext?: ApprovalContext
}
export type McpCallOptions = McpRequestOptions & {
  readonly caller?: McpCaller
  /**
   * Recheck the local execution scope after connection/credential waits, immediately before dispatch: an Effect bound
   * to the caller's services (`bound`), which the manager runs at its SDK boundary.
   */
  readonly authorize?: Effect.Effect<void, AppError>
  readonly approvalId?: string
  readonly approvalContext?: ApprovalContext
}
export type McpToolResult = CallToolResult

/** One skill as an authority check names it: its name and, when known, the URI of its `SKILL.md`. */
export type SkillIdentity = { readonly name: string; readonly uri?: string }

/**
 * Skills transport authority is checked again for every HTTP dispatch, including refresh retries: per server, an Effect
 * bound to the caller's services. The library asks it about one skill too (`skill`), before loading or reading it.
 */
export type SkillRequestOptions = RequestOptions & {
  readonly authorize?: (connectionId: string, skill?: SkillIdentity) => Effect.Effect<void, AppError>
}
