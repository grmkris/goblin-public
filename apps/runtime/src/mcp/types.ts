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
import type { McpOutcome, McpServerConfig } from '@goblin/contracts'
import type * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import type { Grant } from './grants.ts'
export type { McpServerConfig }
/**
 * Who makes a call: the model, an App, the owner, or goblin's own paid inference paying its model call from the owner's
 * wallet (`inference`, ADR 0047: only a first-class profile's payment tool, never from model text).
 */
export type McpCaller = 'model' | 'app' | 'human' | 'inference'
/**
 * Who a use of a connection is for: the owner or the model, waiting on it now (`foreground`), or work goblin does on
 * its own (`background`: Events polls, notices, agent-app jobs, the skills learner). Only foreground use holds the
 * connection's listen stream for tool changes.
 */
export type McpUse = 'foreground' | 'background'

/**
 * How a held call ended, for the conversation that held it: goblin's words for the model, the outcome with the
 * server's result, and the connection it came from, by its label.
 */
export type HeldCallOutcome = { readonly text: string; readonly outcome: McpOutcome; readonly from: string }
export type McpRequestOptions = RequestOptions & {
  /** Host metadata only. Strip before passing options to the remote SDK. */
  readonly runContext?: { readonly conversationId: string; readonly taskId: string }
  /** Host metadata only, stripped like `runContext`; the caller's default when absent. */
  readonly use?: McpUse
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
  /**
   * How long one tool call may go without an answer or a progress notification (default 90 s); a server that reports
   * progress extends it, up to `toolDeadlineMs` in all (default 5 minutes).
   */
  readonly toolTimeoutMs?: number
  readonly toolDeadlineMs?: number
  /** Close a connection this long after its last use (default 5 minutes). */
  readonly idleMs?: number
  /**
   * Close a connection's listen stream for tool changes this long after its last use (default 60 s, ADR 0042): an open
   * stream keeps the agent's Durable Object awake.
   */
  readonly listenIdleMs?: number
  /** Where each remote step is reported (the run ledger, ADR 0024); a log line when absent. */
  readonly report?: StepReport
  /**
   * Told when a connection's tools, as listed whole, differ from the last list it saw (`digest` names the new one), so
   * the owner's Connections page reads them again.
   */
  readonly toolsChanged?: (connectionId: string, digest: string) => Effect.Effect<void>
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
  /** It carries the owner's answer to a URL request (ADR 0042): with an approval, one its dispatch met. */
  readonly answered?: true
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

/** What a server asks before a model's call can complete: the owner opens this link (a URL request, ADR 0042). */
export type UrlPrompt = {
  /** The input request's key in the server's `inputRequests`, answered under the same key. */
  readonly inputKey: string
  /** The server's opaque request state, echoed back with the answer. */
  readonly requestState: string | undefined
  readonly url: string
  readonly message: string
}

/** The owner's answer to a URL request, sent with the call retried. */
export type UrlAnswer = {
  readonly inputKey: string
  readonly action: 'accept' | 'decline'
  readonly requestState: string | undefined
}

/**
 * A model's call, its own or the held call the owner approved for it (`approvalId`): it may meet a URL request, and its
 * retry carries the owner's answer.
 */
export type McpModelCallOptions = Omit<McpCallOptions, 'caller'> & {
  readonly answer?: UrlAnswer
  /** With an `answer`: the tool as it was listed when the server asked, sent to even if the server no longer lists it. */
  readonly heldTool?: Tool
}

/** A model's call that may meet a URL request: the server's result, or what it asks first. */
export type McpModelCallResult =
  | { readonly kind: 'complete'; readonly result: McpToolResult }
  | { readonly kind: 'url'; readonly prompt: UrlPrompt }

/** One skill as an authority check names it: its name and, when known, the URI of its `SKILL.md`. */
export type SkillIdentity = { readonly name: string; readonly uri?: string }

/**
 * Skills transport authority is checked again for every HTTP dispatch, including refresh retries: per server, an Effect
 * bound to the caller's services. The library asks it about one skill too (`skill`), before loading or reading it.
 */
export type SkillRequestOptions = RequestOptions & {
  readonly authorize?: (connectionId: string, skill?: SkillIdentity) => Effect.Effect<void, AppError>
}
