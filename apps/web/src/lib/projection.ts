import { isString, isNumber, identifier, record, records, text } from './boundary.ts'

/** A tool call the assistant made, with its raw arguments. */
export type ToolCallView = { readonly id: string; readonly name: string; readonly arguments: Record<string, unknown> }
/** Committed conversation messages, projected from Pi entries. */
export type ChatMessage =
  | { readonly id: string; readonly role: 'user'; readonly text: string }
  | {
      readonly id: string
      readonly role: 'assistant'
      readonly text: string
      readonly toolCalls: readonly ToolCallView[]
      /** Why this turn has no answer: the model call failed, was stopped, or came back empty. */
      readonly failure?: string
    }
  | {
      readonly id: string
      readonly role: 'tool'
      readonly text: string
      readonly toolCallId: string
      readonly toolName: string
      readonly isError: boolean
      readonly details: unknown
    }
/** A tool running in the current turn. */
export type LiveTool = {
  readonly callId: string
  readonly name: string
  readonly status: 'running' | 'done'
  readonly output: string
}
export type ConversationProjection = {
  readonly messages: readonly ChatMessage[]
  readonly entries: readonly Record<string, unknown>[]
  readonly tools: readonly LiveTool[]
  readonly running: boolean
  readonly partial: string
  readonly partialBlocks: readonly Record<string, unknown>[]
  readonly progress: string
}

/** The provider's raw error, in a sentence the owner can act on; the first line of anything unrecognised. */
export function failureReason(raw: string): string {
  if (/\b429\b|quota|rate.?limit|too many requests/iu.test(raw))
    return 'The model provider refused the request: quota exceeded or rate-limited. Try again later.'
  if (/\b(?:500|502|503|504)\b|overloaded|high demand|unavailable/iu.test(raw))
    return 'The model provider is overloaded or unavailable. Try again in a minute.'
  const line =
    raw
      .split('\n')
      .find((part) => part.trim() !== '')
      ?.trim() ?? ''
  return line === '' ? 'The model call failed.' : `The model call failed: ${line.slice(0, 200)}`
}

/** A turn that ended without an answer says why, instead of rendering nothing. */
function assistantFailure(
  message: Record<string, unknown>,
  content: string,
  calls: readonly ToolCallView[],
): string | undefined {
  if (message.stopReason === 'error') return failureReason(isString(message.errorMessage) ? message.errorMessage : '')
  if (message.stopReason === 'aborted') return 'Stopped before answering.'
  if (content === '' && calls.length === 0 && message.stopReason === 'stop')
    return 'The model returned an empty answer.'
  return undefined
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
      },
    ]
  if (message.role === 'assistant') {
    const toolCalls = records(message.content)
      .filter((block) => block.type === 'toolCall')
      .map((block) => ({
        id: identifier(block.id),
        name: identifier(block.name),
        arguments: record(block.arguments) ?? {},
      }))
    const failure = assistantFailure(message, content, toolCalls)
    return [{ id, role: 'assistant', text: content, toolCalls, ...(failure === undefined ? {} : { failure }) }]
  }
  if (message.role === 'user') return [{ id, role: 'user', text: content }]
  return []
}

function entryMessages(entries: readonly Record<string, unknown>[]): ChatMessage[] {
  return entries.flatMap((entry) =>
    records(entry.model).flatMap((message, index) => entryMessage(message, `${identifier(entry.id)}:${index}`)),
  )
}

function liveTools(value: unknown): LiveTool[] {
  return records(value).map((tool) => ({
    callId: identifier(tool.callId ?? tool.toolCallId),
    name: identifier(tool.name ?? tool.toolName),
    status: tool.status === 'done' ? 'done' : 'running',
    output: isString(tool.output) ? tool.output : '',
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
  return { ...next, entries, ...(event.type === 'message_end' ? { partial: '', partialBlocks: [] } : {}) }
}
function changedBlocks(
  blocks: readonly Record<string, unknown>[],
  change: Record<string, unknown>,
): readonly Record<string, unknown>[] {
  if (change.type === 'message') return records(record(change.message)?.content)
  if (!isNumber(change.contentIndex) || !Number.isInteger(change.contentIndex) || change.contentIndex < 0) return blocks
  const next = [...blocks]
  if (change.type === 'text_delta' && isString(change.delta)) {
    const block = next[change.contentIndex]
    next[change.contentIndex] = { ...block, type: 'text', text: text(block?.text) + change.delta }
  } else if (change.type === 'text_start' || change.type === 'block') {
    const block = record(change.block)
    if (block) next[change.contentIndex] = block
  }
  return next
}
function updatedPartial(
  next: ConversationProjection,
  blocks: readonly Record<string, unknown>[],
): ConversationProjection {
  return { ...next, partialBlocks: blocks, partial: text(blocks) }
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
function projectedEvent(next: ConversationProjection, event: Record<string, unknown>): ConversationProjection {
  switch (event.type) {
    case 'snapshot':
      return projectSnapshot(event)
    case 'entry_appended':
    case 'message_end':
      return appended(next, event)
    case 'run_start':
      return { ...next, running: true, progress: 'Agent is working' }
    case 'run_end':
      return { ...next, running: false, progress: 'Ready', partial: '', partialBlocks: [], tools: [] }
    case 'message_start':
      return updatedPartial(next, records(record(event.message)?.content))
    case 'message_update':
      return updatedPartial(next, records(event.changes).reduce(changedBlocks, next.partialBlocks))
    case 'tool_execution_start':
      return {
        ...next,
        tools: [
          ...next.tools.filter((tool) => tool.callId !== event.toolCallId),
          { callId: identifier(event.toolCallId), name: identifier(event.toolName), status: 'running', output: '' },
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
export function projectBatch(previous: ConversationProjection, value: unknown): ConversationProjection {
  if (!Array.isArray(value)) throw new Error('Invalid Pi event batch')
  return records(value).reduce<ConversationProjection>(
    (next, event) => refreshed(projectedEvent(next, event)),
    previous,
  )
}
