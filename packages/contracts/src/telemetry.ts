import * as Schema from 'effect/Schema'
import { ChatId, OperationId, TopicId } from './ids.ts'

/**
 * What one run event records (ADR 0024). A turn, a model attempt, a tool call: their ids, timing, outcome and scalar
 * attributes, never message, prompt or tool content.
 */
export const RunEventKind = Schema.Literals([
  'turn.submitted',
  'model.attempt',
  'model.aux',
  'tool.call',
  'compaction',
  'channel.received',
  'channel.reply',
  'recovery',
  'mcp.request',
  'error',
  'flow',
])
export type RunEventKind = typeof RunEventKind.Type

/** `started` until it ends; `interrupted` when the object stopped before it could end (eviction, deploy). */
export const RunEventStatus = Schema.Literals(['started', 'ok', 'error', 'blocked', 'interrupted'])
export type RunEventStatus = typeof RunEventStatus.Type

/** Scalar values only, so an attribute fits a log field and a trace span alike. */
export const RunAttributes = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean]))
export type RunAttributes = typeof RunAttributes.Type

export const RunEvent = Schema.Struct({
  id: Schema.String,
  kind: RunEventKind,
  status: RunEventStatus,
  conversationId: Schema.optional(Schema.String),
  /** The submission's operation id (Pi's request id), when the event belongs to one turn. */
  operationId: Schema.optional(Schema.String),
  /** Pi's task id for model attempts and tool calls. */
  taskId: Schema.optional(Schema.String),
  /** Epoch milliseconds. */
  startedAt: Schema.Number,
  endedAt: Schema.optional(Schema.Number),
  attributes: RunAttributes,
})
export type RunEvent = typeof RunEvent.Type

/**
 * Attribute names. `gen_ai.*` follow the OpenTelemetry GenAI semantic conventions, so a trace or log tool that knows
 * them reads goblin's too; `error.type` is OpenTelemetry's general one; `goblin.*` are goblin's own.
 */
export const RunAttribute = {
  operation: 'gen_ai.operation.name',
  provider: 'gen_ai.provider.name',
  requestModel: 'gen_ai.request.model',
  responseModel: 'gen_ai.response.model',
  responseId: 'gen_ai.response.id',
  finishReason: 'gen_ai.response.finish_reasons',
  inputTokens: 'gen_ai.usage.input_tokens',
  outputTokens: 'gen_ai.usage.output_tokens',
  cacheReadTokens: 'gen_ai.usage.cache_read.input_tokens',
  cacheWriteTokens: 'gen_ai.usage.cache_creation.input_tokens',
  reasoningTokens: 'gen_ai.usage.reasoning.output_tokens',
  toolName: 'gen_ai.tool.name',
  toolCallId: 'gen_ai.tool.call.id',
  errorType: 'error.type',
  /** A fixed host-owned summary. Private error text is available only in conversation inspection. */
  error: 'goblin.error',
  /** Pi entry id that completed this attempt or tool call. */
  entry: 'goblin.entry',
  cutoff: 'goblin.cutoff',
  emptyAnswer: 'goblin.empty_answer',
  coverageGap: 'goblin.coverage_gap',
  /** Why a turn went unanswered or a task ended (`faulted`, `aborted`, …). */
  reason: 'goblin.reason',
  /** Which try of the generation this is, from 1. */
  attempt: 'goblin.attempt',
  /** When the first partial response was committed, epoch ms; Pi commits partials at most every ~100 ms. */
  firstPartialAt: 'goblin.first_partial_at',
  argumentBytes: 'goblin.tool.argument_bytes',
  resultBytes: 'goblin.tool.result_bytes',
  toolFamily: 'goblin.tool.family',
  blockedReason: 'goblin.blocked_reason',
  mcpServer: 'goblin.mcp.server',
  mcpTool: 'goblin.mcp.tool',
  /** `connect`, `call`, `skills` or `events`: one remote MCP step. */
  mcpStep: 'goblin.mcp.step',
  mcpMethod: 'goblin.mcp.method',
  /** Shared transport discovery belongs to the connection; caller waits carry their own explicit scope. */
  sharedConnection: 'goblin.mcp.shared_connection',
  source: 'goblin.source',
  /** What a model call outside a turn was for: `naming`, `memory`, `skill`, `app_llm`, `retrieval` or `decision`. */
  purpose: 'goblin.purpose',
  channel: 'goblin.channel',
  /** The channel's own id for the message (mygram's inbox id). */
  channelMessage: 'goblin.channel.message',
  /** `sent`, or `given_up` when the turn never answered within the channel's window. */
  delivery: 'goblin.delivery',
  pieces: 'goblin.channel.pieces',
  compactionReason: 'goblin.compaction.reason',
  taskKind: 'goblin.task.kind',
  /** `restarted` for an event the object's restart cut short; `resumed` for one that finished after it. */
  recovery: 'goblin.recovery',
  /** How many events a restart found still started (and so interrupted). */
  interrupted: 'goblin.interrupted',
  /** Set when attributes were dropped or shortened to stay within the bound. */
  truncated: 'goblin.truncated',
  /** A `flow` event's `FlowName`, how it came in, who acted and how it ended (`FlowEvent`). */
  flow: 'goblin.flow',
  flowVia: 'goblin.flow.via',
  flowStatus: 'goblin.flow.status',
  actor: 'goblin.actor',
  /** Who an operation's receipt says started it: `owner`, `client`, `telegram`, `agent`, `routine` or `system`. */
  origin: 'goblin.origin',
  /** Logical chat ids (ADR 0030), never a Pi session id. */
  chat: 'goblin.chat',
  parentChat: 'goblin.chat.parent',
  topic: 'goblin.topic',
  /** The operation that caused this one: a thread's first send names its `startThread`. */
  parentOperation: 'goblin.operation.parent',
  /** How many of what a flow handled: Personas asked, Delegates spawned, entries moved. */
  count: 'goblin.count',
  personaOrder: 'goblin.persona.order',
  synthesize: 'goblin.subagent.synthesize',
} as const

/**
 * The conversation flows that record a `flow` event: how people and agents move through conversations (replies, "+",
 * start thread, move, Personas, Delegates, Topics, routines, Telegram, decision proposals, URL requests, step-ups and
 * top-ups), plus browser crashes.
 */
export const FlowName = Schema.Literals([
  'send',
  'ask_client',
  'telegram',
  'persona_ask',
  'persona_answer',
  'start',
  'reply',
  'empty',
  'move',
  'share',
  'close',
  'stop',
  'subagent_spawn',
  'subagent_report',
  'subagent_synthesize',
  'topic_create',
  'topic_archive',
  'thread_announce',
  'organize_undo',
  'routine_fire',
  'routine_report',
  'telegram_delivery',
  'decision_propose',
  'decision_confirm',
  'decision_dismiss',
  'client_error',
  /** A model's MCP call met a URL request and is held for the owner (ADR 0042). */
  'url_request',
  /** The owner pressed Done and the server is still waiting. */
  'url_request_wait',
  /** The owner pressed Done and the server answered (or the retry failed, or the request had expired). */
  'url_request_finish',
  /** The owner cancelled a URL request. */
  'url_request_cancel',
  /** A model's MCP call needed more access than the connection's sign-in granted. */
  'scope_required',
  /** The owner started signing a connection in again with more access. */
  'step_up',
  /** goblin moved funds from the Goblin Wallet to a prepaid server's own balance, or was refused (ADR 0049). */
  'top_up',
])
export type FlowName = typeof FlowName.Type

/** The surface a flow came in through. */
export const FlowVia = Schema.Literals(['app', 'mcp', 'telegram', 'tool', 'schedule', 'system'])
export type FlowVia = typeof FlowVia.Type

/** Who acted. */
export const FlowActor = Schema.Literals(['owner', 'client', 'agent', 'persona', 'subagent', 'routine', 'system'])
export type FlowActor = typeof FlowActor.Type

/** How a flow ended: `replayed` found an earlier result for the same operation id; `refused` was turned away. */
export const FlowStatus = Schema.Literals(['ok', 'replayed', 'refused', 'error'])
export type FlowStatus = typeof FlowStatus.Type

export const PersonaOrder = Schema.Literals(['parallel', 'sequence'])
export type PersonaOrder = typeof PersonaOrder.Type

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * One step of a conversation flow, content-free (ADR 0024): ids, closed classifications, counts and a duration only.
 * It becomes one run-ledger event of kind `flow`.
 */
export const FlowEvent = Schema.Struct({
  flow: FlowName,
  via: FlowVia,
  actor: FlowActor,
  chat: Schema.optional(ChatId),
  parentChat: Schema.optional(ChatId),
  topic: Schema.optional(TopicId),
  operationId: Schema.optional(OperationId),
  parentOperation: Schema.optional(OperationId),
  count: Schema.optional(Count),
  personaOrder: Schema.optional(PersonaOrder),
  synthesize: Schema.optional(Schema.Boolean),
  status: FlowStatus,
  /** A safe failure code (`safeErrorType`), never error text. */
  errorType: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:-]{1,80}$/u))),
  ms: Schema.optional(Count),
})
export type FlowEvent = typeof FlowEvent.Type
