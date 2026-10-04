import type { AppContext } from '@purrable/contracts'
import { isString, isNumber, identifier, record, records, text } from './boundary.ts'
import { sharedContext } from './app-context.ts'

/** A tool call the assistant made, with its raw arguments. */
export type ToolCallView = { readonly id: string; readonly name: string; readonly arguments: Record<string, unknown> }
/** The tokens one model response used, as Pi records them (cost is not tracked: the catalog prices are zero). */
export type TokenUsage = {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly totalTokens: number
}
/**
 * Committed conversation messages, projected from Pi entries. `timestamp` (epoch ms) is Pi's, when the message has
 * one; optional fields are absent rather than empty.
 */
export type ChatMessage =
  | {
      readonly id: string
      readonly role: 'user'
      readonly text: string
      /** What an open App shared with this message, labelled untrusted for the agent. */
      readonly context?: readonly AppContext[]
      /** Who wrote it, when not the owner in this browser: Telegram, an MCP client, a subagent. */
      readonly author?: string
      readonly timestamp?: number
    }
  | {
      readonly id: string
      readonly role: 'assistant'
      readonly text: string
      readonly toolCalls: readonly ToolCallView[]
      /** The model's visible thinking, when it emitted any (redacted thinking is left out). */
      readonly reasoning?: string
      readonly usage?: TokenUsage
      readonly timestamp?: number
      /** Why this turn has no answer: the model call failed, was stopped, or came back empty. */
      readonly failure?: TurnFailure
    }
  | {
      readonly id: string
      readonly role: 'tool'
      readonly text: string
      readonly toolCallId: string
      readonly toolName: string
      readonly isError: boolean
      readonly details: unknown
      readonly timestamp?: number
    }
/** A tool running in the current turn. `startedAt` is when this browser saw it start (Pi's slots carry no time). */
export type LiveTool = {
  readonly callId: string
  readonly name: string
  readonly status: 'running' | 'done'
  readonly output: string
  readonly args: Record<string, unknown>
  readonly startedAt?: number
}
export type ConversationProjection = {
  readonly messages: readonly ChatMessage[]
  readonly entries: readonly Record<string, unknown>[]
  readonly tools: readonly LiveTool[]
  readonly running: boolean
  readonly partial: string
  /** The in-flight message's thinking so far. */
  readonly partialReasoning: string
  readonly partialBlocks: readonly Record<string, unknown>[]
  readonly progress: string
}

/**
 * Why a turn has no answer. `provider`: the model's provider refused or is down, so another model may answer.
 * `stopped`: the owner stopped it, which is a choice rather than a failure.
 */
export type TurnFailure = { readonly text: string; readonly provider: boolean; readonly stopped?: true }

/** The provider's raw error, in a sentence the owner can act on; the first line of anything unrecognised. */
export function failureReason(raw: string): TurnFailure {
  if (/\b429\b|quota|rate.?limit|too many requests/iu.test(raw))
    return { text: 'The model provider refused the request: quota exceeded or rate-limited.', provider: true }
  if (/\b(?:500|502|503|504)\b|overloaded|high demand|unavailable/iu.test(raw))
    return { text: 'The model provider is overloaded or unavailable.', provider: true }
  const line =
    raw
      .split('\n')
      .find((part) => part.trim() !== '')
      ?.trim() ?? ''
  return {
    text: line === '' ? 'The model call failed.' : `The model call failed: ${line.slice(0, 200)}`,
    provider: false,
  }
}

/** A turn that ended without an answer says why, instead of rendering nothing. */
function assistantFailure(
  message: Record<string, unknown>,
  content: string,
  calls: readonly ToolCallView[],
): TurnFailure | undefined {
  if (message.stopReason === 'error') return failureReason(isString(message.errorMessage) ? message.errorMessage : '')
  if (message.stopReason === 'aborted') return { text: 'Stopped before answering.', provider: false, stopped: true }
  if (content === '' && calls.length === 0 && message.stopReason === 'stop')
    return { text: 'The model returned an empty answer.', provider: false }
  return undefined
}

/** The visible thinking in content blocks; redacted thinking is an opaque payload, not text for the owner. */
export function reasoningText(blocks: unknown): string {
  return records(blocks)
    .filter((block) => block.type === 'thinking' && block.redacted !== true && isString(block.thinking))
    .map((block) => text(block.thinking).trim())
    .filter((thought) => thought !== '')
    .join('\n\n')
}

const count = (value: unknown): number => (isNumber(value) && Number.isFinite(value) ? value : 0)
function tokenUsage(value: unknown): TokenUsage | undefined {
  const usage = record(value)
  if (usage === undefined) return undefined
  return {
    input: count(usage.input),
    output: count(usage.output),
    cacheRead: count(usage.cacheRead),
    cacheWrite: count(usage.cacheWrite),
    totalTokens: count(usage.totalTokens),
  }
}
const stamped = (message: Record<string, unknown>) =>
  isNumber(message.timestamp) && Number.isFinite(message.timestamp) ? { timestamp: message.timestamp } : {}

function assistantMessage(message: Record<string, unknown>, id: string, content: string): ChatMessage {
  const toolCalls = records(message.content)
    .filter((block) => block.type === 'toolCall')
    .map((block) => ({
      id: identifier(block.id),
      name: identifier(block.name),
      arguments: record(block.arguments) ?? {},
    }))
  const failure = assistantFailure(message, content, toolCalls)
  const reasoning = reasoningText(message.content)
  const usage = tokenUsage(message.usage)
  return {
    id,
    role: 'assistant',
    text: content,
    toolCalls,
    ...(reasoning === '' ? {} : { reasoning }),
    ...(usage === undefined ? {} : { usage }),
    ...stamped(message),
    ...(failure === undefined ? {} : { failure }),
  }
}

function entryMessage(message: Record<string, unknown>, id: string): ChatMessage[] {
  const content = text(message.content)
  if (message.role === 'toolResult')
    return [
      {
        id,
        role: 'tool',
        text: content,
        toolCallId: identifier(message.toolCallId),
        toolName: identifier(message.toolName),
        isError: message.isError === true,
        details: message.details,
        ...stamped(message),
      },
    ]
  if (message.role === 'assistant') return [assistantMessage(message, id, content)]
  if (message.role === 'user') {
    const shared = sharedContext(message.content)
    const context = shared.context.length === 0 ? {} : { context: shared.context }
    const author = shared.author === undefined ? {} : { author: shared.author }
    return [{ id, role: 'user', text: shared.text, ...context, ...author, ...stamped(message) }]
  }
  return []
}

/** Committed entries never change, so each one is projected once and reused while it stays in the transcript. */
const projected = new WeakMap<Record<string, unknown>, readonly ChatMessage[]>()
function messagesOf(entry: Record<string, unknown>): readonly ChatMessage[] {
  const cached = projected.get(entry)
  if (cached !== undefined) return cached
  const messages = records(entry.model).flatMap((message, index) =>
    entryMessage(message, `${identifier(entry.id)}:${index}`),
  )
  projected.set(entry, messages)
  return messages
}
function entryMessages(entries: readonly Record<string, unknown>[]): ChatMessage[] {
  return entries.flatMap(messagesOf)
}

function liveTools(value: unknown): LiveTool[] {
  return records(value).map((tool) => ({
    callId: identifier(tool.callId ?? tool.toolCallId),
    name: identifier(tool.name ?? tool.toolName),
    status: tool.status === 'done' ? 'done' : 'running',
    output: isString(tool.output) ? tool.output : '',
    args: {},
  }))
}

export function projectSnapshot(value: unknown): ConversationProjection {
  const snapshot = record(value)
  if (snapshot?.type !== 'snapshot' || !Array.isArray(snapshot.entries)) throw new Error('Invalid Pi snapshot')
  const entries = records(snapshot.entries)
  const tools = liveTools(snapshot.tools)
  const generation = record(snapshot.generation)
  const partialBlocks = records(record(generation?.message)?.content)
  const partial = text(partialBlocks)
  const partialReasoning = reasoningText(partialBlocks)
  const running = record(snapshot.run) !== undefined
  const inbox = records(snapshot.inbox)
  const progress = record(generation?.retry)
    ? 'Waiting for model retry'
    : record(generation?.deferred)
      ? 'Waiting for deferred model response'
      : running
        ? 'Agent is working'
        : inbox.length
          ? `${inbox.length} queued follow-up(s)`
          : 'Ready'
  return {
    entries,
    tools,
    running,
    partial,
    partialReasoning,
    partialBlocks,
    progress,
    messages: entryMessages(entries),
  }
}

function refreshed(next: ConversationProjection): ConversationProjection {
  return { ...next, messages: entryMessages(next.entries) }
}
function appended(next: ConversationProjection, event: Record<string, unknown>): ConversationProjection {
  const entry = record(event.entry)
  const entries = entry ? [...next.entries.filter((item) => item.id !== entry.id), entry] : next.entries
  return {
    ...next,
    entries,
    ...(event.type === 'message_end' ? { partial: '', partialReasoning: '', partialBlocks: [] } : {}),
  }
}
/** Changes that put a whole block in place: a block starting, or Pi replacing one. */
const STARTS = new Set(['text_start', 'thinking_start', 'toolcall_start', 'block'])
function changedBlocks(
  blocks: readonly Record<string, unknown>[],
  change: Record<string, unknown>,
): readonly Record<string, unknown>[] {
  if (change.type === 'message') return records(record(change.message)?.content)
  if (!isNumber(change.contentIndex) || !Number.isInteger(change.contentIndex) || change.contentIndex < 0) return blocks
  const next = [...blocks]
  const block = next[change.contentIndex]
  if (change.type === 'text_delta' && isString(change.delta))
    next[change.contentIndex] = { ...block, type: 'text', text: text(block?.text) + change.delta }
  else if (change.type === 'thinking_delta' && isString(change.delta))
    next[change.contentIndex] = { ...block, type: 'thinking', thinking: text(block?.thinking) + change.delta }
  else if (STARTS.has(identifier(change.type))) {
    const started = record(change.block)
    if (started) next[change.contentIndex] = started
  }
  return next
}
function updatedPartial(
  next: ConversationProjection,
  blocks: readonly Record<string, unknown>[],
): ConversationProjection {
  return { ...next, partialBlocks: blocks, partial: text(blocks), partialReasoning: reasoningText(blocks) }
}
function toolOutput(tool: LiveTool, event: Record<string, unknown>): LiveTool {
  if (tool.callId !== event.toolCallId) return tool
  const output = record(event.output)
  return {
    ...tool,
    output: isString(output?.set)
      ? output.set
      : tool.output.slice(isNumber(output?.trimStart) ? output.trimStart : 0) +
        (isString(output?.append) ? output.append : ''),
  }
}
function projectedEvent(
  next: ConversationProjection,
  event: Record<string, unknown>,
  now: number,
): ConversationProjection {
  switch (event.type) {
    case 'snapshot':
      return projectSnapshot(event)
    case 'entry_appended':
    case 'message_end':
      return appended(next, event)
    case 'run_start':
      return { ...next, running: true, progress: 'Agent is working' }
    case 'run_end':
      return {
        ...next,
        running: false,
        progress: 'Ready',
        partial: '',
        partialReasoning: '',
        partialBlocks: [],
        tools: [],
      }
    case 'message_start':
      return updatedPartial(next, records(record(event.message)?.content))
    case 'message_update':
      return updatedPartial(next, records(event.changes).reduce(changedBlocks, next.partialBlocks))
    case 'tool_execution_start':
      return {
        ...next,
        tools: [
          ...next.tools.filter((tool) => tool.callId !== event.toolCallId),
          {
            callId: identifier(event.toolCallId),
            name: identifier(event.toolName),
            status: 'running',
            output: '',
            args: record(event.args) ?? {},
            startedAt: now,
          },
        ],
      }
    case 'tool_execution_update':
      return { ...next, tools: next.tools.map((tool) => toolOutput(tool, event)) }
    case 'tool_execution_end':
      return {
        ...appended(next, event),
        tools: next.tools.map((tool) => (tool.callId === event.toolCallId ? { ...tool, status: 'done' } : tool)),
      }
    case 'auto_retry_start':
      return { ...next, progress: 'Waiting for model retry' }
    case 'deferred_poll':
      return { ...next, progress: 'Waiting for deferred model response' }
    case 'task_failed':
      return { ...next, progress: isString(event.message) ? event.message : 'Task failed' }
    default:
      return next
  }
}
/** Applies one SSE batch; `now` stamps tools that start in it. Messages are rebuilt once per batch, not per event. */
export function projectBatch(
  previous: ConversationProjection,
  value: unknown,
  now: number = Date.now(),
): ConversationProjection {
  if (!Array.isArray(value)) throw new Error('Invalid Pi event batch')
  return refreshed(
    records(value).reduce<ConversationProjection>((next, event) => projectedEvent(next, event, now), previous),
  )
}
