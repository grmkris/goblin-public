import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { EntryDraft } from '@earendil-works/pi-durable'
import type { ReplayEvent } from '../src/protocol.ts'
import type { BuildRequest } from '../src/protocol.ts'

export function compatibleReplay(previous: BuildRequest, current: BuildRequest) {
  return (
    JSON.stringify({ ...previous, events: [] }) === JSON.stringify({ ...current, events: [] }) &&
    current.events.length >= previous.events.length &&
    previous.events.every((event, at) => JSON.stringify(current.events[at]) === JSON.stringify(event))
  )
}

/** Persisted system instructions bind provider attribution through native Pi recovery. User/tool text cannot route it. */
export function requestScope(messages: readonly Message[], artifact: string): string {
  const systems = JSON.stringify(messages.filter((message) => message.role === 'system'))
  return /BENCH_OPERATION_ID=([a-zA-Z0-9_.:-]+)/u.exec(systems)?.[1] ?? artifact
}

/** Preserve roles and original tool-call pairs, with a source citation marker carried through summaries. */
export function replayEntry(event: ReplayEvent): EntryDraft {
  const text = `[source:${event.id}] ${event.text}`
  const timestamp = event.timestamp ?? 0
  if (event.kind === 'user') return { kind: 'pi.user', model: [{ role: 'user', content: text, timestamp }] }
  if (event.kind === 'tool-result')
    return {
      kind: 'pi.tool-result',
      model: [
        {
          role: 'toolResult',
          toolCallId: event.callId ?? '',
          toolName: event.toolName ?? '',
          content: [{ type: 'text', text }],
          isError: event.isError ?? false,
          timestamp,
        },
      ],
    }
  const assistant: AssistantMessage = {
    role: 'assistant',
    api: 'openai-completions',
    provider: 'replay',
    model: 'replay',
    timestamp,
    content:
      event.kind === 'tool-call'
        ? [
            { type: 'text', text: `[source:${event.id}] Historical tool call (already recorded).` },
            {
              type: 'toolCall',
              id: event.callId ?? '',
              name: event.toolName ?? '',
              arguments: event.arguments ?? { source: event.id, input: event.text },
            },
          ]
        : [{ type: 'text', text }],
    stopReason: event.kind === 'tool-call' ? 'toolUse' : 'stop',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
  return { kind: 'pi.assistant', model: [assistant] }
}

/** Adjacent blocks from one streamed assistant response become one Pi message, including parallel calls. */
export function replayGroups(events: readonly ReplayEvent[]) {
  const groups: { ids: string[]; entry: EntryDraft; groupId: string | undefined }[] = []
  for (const event of events) {
    const entry = { ...replayEntry(event), data: { benchSourceIds: [event.id] } }
    const previous = groups.at(-1)
    const before = previous?.entry.model?.[0]
    const after = entry.model?.[0]
    if (
      event.groupId !== undefined &&
      previous?.groupId === event.groupId &&
      before?.role === 'assistant' &&
      after?.role === 'assistant'
    ) {
      previous.entry = {
        ...previous.entry,
        data: { benchSourceIds: [...previous.ids, event.id] },
        model: [{ ...before, content: [...before.content, ...after.content], stopReason: after.stopReason }],
      }
      previous.ids.push(event.id)
    } else groups.push({ ids: [event.id], entry, groupId: event.groupId })
  }
  return groups
}

/** Bound native compaction deltas without separating parallel calls, results, or streamed assistant blocks. */
function updateOpen(open: Set<string>, source: ReadonlyMap<string, ReplayEvent>, ids: readonly string[]) {
  for (const id of ids) {
    const event = source.get(id)
    if (event?.kind === 'tool-call' && event.callId !== undefined) open.add(event.callId)
    if (event?.kind === 'tool-result' && event.callId !== undefined) open.delete(event.callId)
  }
}
export function replayBatches(events: readonly ReplayEvent[], maxBytes: number) {
  const batches: ReturnType<typeof replayGroups>[] = []
  let batch: ReturnType<typeof replayGroups> = []
  let bytes = 0
  let closed: ReturnType<typeof replayGroups> = []
  let closedBytes = 0
  const open = new Set<string>()
  const source = new Map(events.map((event) => [event.id, event]))
  for (const group of replayGroups(events)) {
    closed.push(group)
    closedBytes += new TextEncoder().encode(JSON.stringify(group.entry.model)).length
    updateOpen(open, source, group.ids)
    if (open.size > 0) continue
    if (closedBytes > maxBytes) throw new Error('A closed source exchange exceeds the declared replay batch limit')
    if (bytes + closedBytes > maxBytes && batch.length > 0) {
      batches.push(batch)
      batch = []
      bytes = 0
    }
    batch.push(...closed)
    bytes += closedBytes
    closed = []
    closedBytes = 0
  }
  if (open.size > 0) throw new Error('Replay batch leaves tool calls open')
  if (batch.length > 0) batches.push(batch)
  return batches
}
