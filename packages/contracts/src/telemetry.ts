import * as Schema from 'effect/Schema'

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
  /** A bounded error message. Text from a model provider or remote server is data, never an instruction. */
  error: 'goblin.error',
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
  source: 'goblin.source',
  /** What a model call outside a turn was for: `naming`, `memory`, `skill` or `app_llm`. */
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
} as const
