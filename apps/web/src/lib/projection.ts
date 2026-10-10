// A conversation as the browser follows it (`conversation-stream.ts`): a Pi snapshot, then live batches, projected
// into its messages, the message in flight, the tools running and the inbox.
import type { QueuedInput } from '@goblin/contracts'
import { Data } from 'effect'
import { type ChatMessage, reasoningText } from './chat-messages.ts'
import { entryMessages } from './entry-messages.ts'
import { identifier, isNumber, isString, record, records, text } from './values.ts'

/** A tool running in the current turn. `startedAt` is when this browser saw it start (Pi's slots carry no time). */
export type LiveTool = {
  readonly callId: string
  readonly name: string
  readonly status: 'running' | 'done'
  readonly output: string
  readonly args: Record<string, unknown>
  readonly startedAt?: number
}
/**
 * When this browser saw a tool start and end, by call id. Kept after the run ends, when the live tools are cleared, so a
 * row's time does not change then: without it the start fell back to when the asking message began (including the
 * model's thinking) and every duration of the turn changed at once.
 */
export type ToolTimes = { readonly startedAt: number; readonly endedAt?: number }
const TOOL_TIMES_KEPT = 200

function withToolTime(
  times: ReadonlyMap<string, ToolTimes> | undefined,
  callId: string,
  change: (before: ToolTimes | undefined) => ToolTimes,
): ReadonlyMap<string, ToolTimes> {
  const next = new Map(times)
  next.set(callId, change(next.get(callId)))
  // Oldest first: a map iterates in insertion order.
  for (const old of [...next.keys()].slice(0, Math.max(0, next.size - TOOL_TIMES_KEPT))) next.delete(old)
  return next
}

export type ConversationProjection = {
  readonly messages: readonly ChatMessage[]
  readonly entries: readonly Record<string, unknown>[]
  readonly tools: readonly LiveTool[]
  /** What this browser saw of the tools' times (`ToolTimes`); none after a snapshot, which carries no times. */
  readonly toolTimes?: ReadonlyMap<string, ToolTimes>
  readonly running: boolean
  readonly partial: string
  /** The in-flight message's thinking so far. */
  readonly partialReasoning: string
  /**
   * When the in-flight message started (Pi's timestamp, the same on the committed message), so its rows keep one React
   * key from the first token to the commit and an open Thoughts stays open.
   */
  readonly partialAt?: number | undefined
  readonly partialBlocks: readonly Record<string, unknown>[]
  readonly progress: string
  readonly inbox: readonly Pick<QueuedInput, 'id' | 'mode'>[]
  readonly queued: readonly QueuedInput[]
  readonly queueNotice: string
}

/**
 * Where the snapshot's transcript starts when a marker cut it (the model sees a memory view or summary instead of what
 * came before): the first entry kept after the marker. History before it is read in pages.
 */
export function historyStart(projection: ConversationProjection): number | undefined {
  const head = projection.entries[0]?.head
  return isNumber(head) ? head : undefined
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

/** Native inbox events carry membership and mode; the authenticated queue read supplies content separately. */
function inputInbox(value: unknown): Pick<QueuedInput, 'id' | 'mode'>[] {
  return records(value).flatMap((item) =>
    isNumber(item.id) &&
    Number.isSafeInteger(item.id) &&
    item.id > 0 &&
    (item.mode === 'followUp' || item.mode === 'steer')
      ? [{ id: item.id, mode: item.mode }]
      : [],
  )
}
export const queuedProgress = (queuedCount: number): string =>
  `${queuedCount} queued ${queuedCount === 1 ? 'message' : 'messages'}`

/** A frame of a chat's stream that is not the shape Pi sends: a bug, or a server this tab does not know. */
export class UnreadableFrame extends Data.TaggedError('UnreadableFrame')<{
  readonly frame: 'snapshot' | 'batch'
  readonly message: string
}> {
  constructor(frame: 'snapshot' | 'batch') {
    super({ frame, message: frame === 'snapshot' ? 'Invalid Pi snapshot' : 'Invalid Pi event batch' })
  }
}

export function projectSnapshot(value: unknown): ConversationProjection {
  const snapshot = record(value)
  if (snapshot?.type !== 'snapshot' || !Array.isArray(snapshot.entries)) throw new UnreadableFrame('snapshot')
  const entries = records(snapshot.entries)
  const tools = liveTools(snapshot.tools)
  const generation = record(snapshot.generation)
  const partialBlocks = records(record(generation?.message)?.content)
  const partialAt = startedAt(generation?.message)
  const partial = text(partialBlocks)
  const partialReasoning = reasoningText(partialBlocks)
  const running = record(snapshot.run) !== undefined
  const inbox = inputInbox(snapshot.inbox)
  const progress = record(generation?.retry)
    ? 'Waiting for model retry'
    : record(generation?.deferred)
      ? 'Waiting for deferred model response'
      : running
        ? 'Agent is working'
        : inbox.length
          ? queuedProgress(inbox.length)
          : 'Ready'
  return {
    entries,
    tools,
    running,
    partial,
    partialReasoning,
    partialBlocks,
    partialAt,
    progress,
    messages: entryMessages(entries),
    inbox,
    queued: [],
    queueNotice: '',
  }
}

/** A Pi message's timestamp (epoch ms), when it has one. */
function startedAt(message: unknown): number | undefined {
  const at = record(message)?.timestamp
  return isNumber(at) && Number.isFinite(at) ? at : undefined
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
    ...(event.type === 'message_end'
      ? { partial: '', partialReasoning: '', partialBlocks: [], partialAt: undefined }
      : {}),
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
    case 'inbox_update': {
      const inbox = inputInbox(event.items)
      return {
        ...next,
        inbox,
        queued: next.queued.filter((item) => inbox.some(({ id }) => id === item.id)),
        progress: next.running ? next.progress : inbox.length > 0 ? queuedProgress(inbox.length) : 'Ready',
      }
    }
    case 'run_start':
      return { ...next, running: true, progress: 'Agent is working' }
    case 'run_end':
      return {
        ...next,
        running: false,
        progress: next.inbox.length > 0 ? queuedProgress(next.inbox.length) : 'Ready',
        partial: '',
        partialReasoning: '',
        partialBlocks: [],
        partialAt: undefined,
        tools: [],
      }
    case 'message_start':
      return { ...updatedPartial(next, records(record(event.message)?.content)), partialAt: startedAt(event.message) }
    case 'message_update':
      return updatedPartial(next, records(event.changes).reduce(changedBlocks, next.partialBlocks))
    case 'tool_execution_start':
      return {
        ...next,
        toolTimes: withToolTime(next.toolTimes, identifier(event.toolCallId), () => ({ startedAt: now })),
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
        toolTimes: withToolTime(next.toolTimes, identifier(event.toolCallId), (before) => ({
          startedAt: before?.startedAt ?? now,
          endedAt: now,
        })),
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
  if (!Array.isArray(value)) throw new UnreadableFrame('batch')
  return refreshed(
    records(value).reduce<ConversationProjection>((next, event) => projectedEvent(next, event, now), previous),
  )
}
