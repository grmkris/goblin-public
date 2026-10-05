import type { Message } from '@earendil-works/pi-ai'
import type { ContextView } from '@earendil-works/pi-durable'
import type { Delivery, ReplayEvent } from '../src/protocol.ts'

export const byteLength = (text: string) => new TextEncoder().encode(text).length

/** Byte offsets round inward to codepoint boundaries, with no replacement characters or skipped continuation. */
export function sourceSlice(text: string, offset: number, length: number) {
  const bytes = new TextEncoder().encode(text)
  let start = Math.min(offset, bytes.length)
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1
  let end = Math.min(bytes.length, start + length)
  while (end > start && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return {
    text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(start, end)),
    start,
    end,
    total: bytes.length,
  }
}

export function delivery(
  event: ReplayEvent,
  origin: Delivery['origin'],
  offset = 0,
  length = byteLength(event.text),
): Delivery {
  const slice = sourceSlice(event.text, offset, length)
  return {
    id: event.id,
    kind: event.kind,
    offsetBytes: slice.start,
    endBytes: slice.end,
    totalBytes: slice.total,
    text: slice.text,
    origin,
  }
}

const messageText = (message: Message): string =>
  typeof message.content === 'string'
    ? message.content
    : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')

/** Native replay-entry metadata, never summary markers, identifies originals still present in the starting context. */
export function contextSources(context: ContextView, events: readonly ReplayEvent[]) {
  return context.entries.flatMap((entry, index) => {
    const data = entry.data
    const ids =
      typeof data === 'object' && data !== null && !Array.isArray(data) && 'benchSourceIds' in data
        ? data.benchSourceIds
        : undefined
    if (!Array.isArray(ids) || entry.head !== undefined) return []
    return (context.contributions[index] ?? []).flatMap((message) => {
      const originals = events.filter(
        (event) => ids.includes(event.id) && messageText(message).includes(`[source:${event.id}] ${event.text}`),
      )
      return originals.length === 0
        ? []
        : [{ message: JSON.stringify(message), deliveries: originals.map((event) => delivery(event, 'context')) }]
    })
  })
}
