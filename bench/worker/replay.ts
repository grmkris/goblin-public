import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { EntryDraft } from '@earendil-works/pi-durable'
import type { ReplayEvent } from '../src/protocol.ts'

/** Persisted system instructions bind provider attribution through native Pi recovery. User/tool text cannot route it. */
export function requestScope(messages: readonly Message[], artifact: string): string {
  const systems = JSON.stringify(messages.filter((message) => message.role === 'system'))
  return /BENCH_OPERATION_ID=([a-zA-Z0-9_.:-]+)/u.exec(systems)?.[1] ?? artifact
}

/** Preserve roles and original tool-call pairs, with a source citation marker carried through summaries. */
export function replayEntry(event: ReplayEvent): EntryDraft {
  const text = `[source:${event.id}] ${event.text}`
  const timestamp = 0
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
          isError: false,
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
            {
              type: 'toolCall',
              id: event.callId ?? '',
              name: event.toolName ?? '',
              arguments: { source: event.id, input: event.text },
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
