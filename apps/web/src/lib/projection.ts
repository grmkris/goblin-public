import { EventType, type Message, type MessagesSnapshotEvent, type StateSnapshotEvent } from '@ag-ui/core'
import { isString, isNumber, identifier, record, records, text } from './boundary.ts'

export type ConversationProjection = {
  readonly messages: MessagesSnapshotEvent
  readonly state: StateSnapshotEvent
  readonly entries: readonly Record<string, unknown>[]
  readonly tools: readonly Record<string, unknown>[]
  readonly running: boolean
  readonly partial: string
  readonly partialBlocks: readonly Record<string, unknown>[]
  readonly progress: string
}

function entryMessages(entries: readonly Record<string, unknown>[]): Message[] {
  return entries.flatMap((entry) =>
    records(entry.model).flatMap((message, index): Message[] => {
      const id = `${identifier(entry.id)}:${index}`
      const content = text(message.content)
      if (message.role === 'toolResult')
        return [{ id, role: 'tool', content, toolCallId: identifier(message.toolCallId) }]
      if (message.role === 'assistant')
        return [
          {
            id,
            role: 'assistant',
            content,
            toolCalls: records(message.content)
              .filter((block) => block.type === 'toolCall')
              .map((block) => ({
                id: identifier(block.id),
                type: 'function',
                function: { name: identifier(block.name), arguments: JSON.stringify(block.arguments ?? {}) },
              })),
          },
        ]
      if (message.role === 'user' || message.role === 'system') return [{ id, role: message.role, content }]
      return []
    }),
  )
}

export function projectSnapshot(value: unknown): ConversationProjection {
  const snapshot = record(value)
  if (snapshot?.type !== 'snapshot' || !Array.isArray(snapshot.entries)) throw new Error('Invalid Pi snapshot')
  const entries = records(snapshot.entries)
  const tools = records(snapshot.tools)
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
    messages: { type: EventType.MESSAGES_SNAPSHOT, messages: entryMessages(entries) },
    state: { type: EventType.STATE_SNAPSHOT, snapshot: { running, tools, inbox, progress } },
  }
}

function refreshed(next: ConversationProjection): ConversationProjection {
  return {
    ...next,
    messages: { type: EventType.MESSAGES_SNAPSHOT, messages: entryMessages(next.entries) },
    state: {
      type: EventType.STATE_SNAPSHOT,
      snapshot: { running: next.running, tools: next.tools, progress: next.progress },
    },
  }
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
function toolOutput(tool: Record<string, unknown>, event: Record<string, unknown>): Record<string, unknown> {
  if (tool.callId !== event.toolCallId) return tool
  const output = record(event.output)
  const current = isString(tool.output) ? tool.output : ''
  return {
    ...tool,
    output: isString(output?.set)
      ? output.set
      : current.slice(isNumber(output?.trimStart) ? output.trimStart : 0) +
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
          { callId: event.toolCallId, name: event.toolName, status: 'running', output: '' },
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
