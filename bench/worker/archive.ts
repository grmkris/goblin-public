import type { Delivery, ReplayEvent } from '../src/protocol.ts'
import { byteLength, delivery } from './sources.ts'

export type RetrievalOutput = {
  readonly text: string
  readonly deliveries: readonly Delivery[]
  readonly unavailable?: boolean
}
const empty = (text: string, unavailable = false): RetrievalOutput => ({ text, deliveries: [], unavailable })

function pairedCall(events: readonly ReplayEvent[], event: ReplayEvent) {
  if (event.kind !== 'tool-result' || event.callId === undefined) return undefined
  const call = events.find((item) => item.kind === 'tool-call' && item.callId === event.callId)
  return call === undefined
    ? undefined
    : { id: call.id, toolName: call.toolName, arguments: call.arguments, text: call.text }
}

function record(events: readonly ReplayEvent[], source: Delivery, compact = false) {
  const event = events.find((item) => item.id === source.id)
  return {
    ...source,
    origin: undefined,
    truncated: source.offsetBytes > 0 || source.endBytes < source.totalBytes,
    nextOffsetBytes: source.endBytes < source.totalBytes ? source.endBytes : null,
    ...(event?.kind === 'tool-result'
      ? {
          isError: event.isError ?? false,
          pairedCall: compact
            ? { id: pairedCall(events, event)?.id, toolName: event.toolName }
            : pairedCall(events, event),
        }
      : {}),
  }
}

/** Fit the complete serialized record, including metadata and JSON escaping, into its response share. */
function fit(
  events: readonly ReplayEvent[],
  event: ReplayEvent,
  origin: Delivery['origin'],
  offset: number,
  options: { readonly limit: number; readonly compact: boolean },
) {
  const { limit, compact } = options
  let low = 0
  let high = Math.min(limit, byteLength(event.text))
  let best: Delivery | undefined
  while (low <= high) {
    const length = Math.floor((low + high) / 2)
    const source = delivery(event, origin, offset, length)
    if (byteLength(JSON.stringify(record(events, source, compact))) <= limit) {
      best = source
      low = length + 1
    } else high = length - 1
  }
  return best?.text === '' ? undefined : best
}

/** Deterministic lexical ranking includes the recorded paired call, so a filename can find its Read result. */
export function archiveSearch(
  events: readonly ReplayEvent[],
  query: string,
  options: { readonly maxBytes: number; readonly compact: boolean } = { maxBytes: 2048, compact: false },
): RetrievalOutput {
  const terms = query.toLowerCase().split(/\W+/u).filter(Boolean)
  const ranked = events
    .map((event, index) => {
      const search = `${event.text} ${JSON.stringify(pairedCall(events, event) ?? {})}`.toLowerCase()
      return { event, index, score: terms.filter((term) => search.includes(term)).length }
    })
    .filter(({ score }) => score > 0)
    .toSorted((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, options.compact ? 2 : 4)
  const deliveries = ranked.flatMap(({ event }) => {
    const at =
      terms
        .map((term) => event.text.toLowerCase().indexOf(term))
        .filter((index) => index >= 0)
        .toSorted((a, b) => a - b)[0] ?? 0
    const offset = Math.max(0, byteLength(event.text.slice(0, at)) - 96)
    const source = fit(events, event, 'search', offset, {
      limit: Math.max(
        0,
        Math.floor((Math.min(2048, options.maxBytes) - 14 - ranked.length) / Math.max(1, ranked.length)),
      ),
      compact: options.compact,
    })
    return source === undefined ? [] : [source]
  })
  return deliveries.length === 0
    ? empty('No matching source events.')
    : {
        text: JSON.stringify({ matches: deliveries.map((source) => record(events, source, options.compact)) }),
        deliveries,
      }
}

/** Unavailable and future IDs have the same response; only the passed authorized prefix is consulted. */
export function archiveRead(
  events: readonly ReplayEvent[],
  id: string,
  offsetBytes = 0,
  maxBytes = 2048,
  compact = false,
): RetrievalOutput {
  const event = events.find((item) => item.id === id)
  if (event === undefined) return empty('Source unavailable.', true)
  if (offsetBytes >= byteLength(event.text)) return empty('End of source.')
  const limit = Math.min(maxBytes, 2048)
  const source = fit(events, event, 'read', offsetBytes, { limit, compact })
  return source === undefined
    ? empty('', true)
    : { text: JSON.stringify(record(events, source, compact)), deliveries: [source] }
}
