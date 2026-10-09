import { type RetrievalSource, SourcesDetails, type SourceUse } from '@goblin/contracts'
import { Option, Schema } from 'effect'
import { entryOfPart } from './threads.ts'

const decodeDetails = Schema.decodeUnknownOption(SourcesDetails)

/** The sources a `search_chats` call returned, from its result's details; none when they are not that shape. */
export const sourcesOf = (details: unknown): readonly RetrievalSource[] =>
  Option.match(decodeDetails(details), { onNone: () => [], onSome: (found) => found.sources })

/** A part of a transcript, as far as placing a source strip goes. */
type Placed = { readonly id: string; readonly kind: string }

/**
 * Where each automatic retrieval's strip shows: under the answer to the owner input it served, that is the last text of
 * the turn the input started (or the input itself while no answer has come). A use naming no input, or one not shown,
 * has no place.
 */
export function sourcePlaces(parts: readonly Placed[], uses: readonly SourceUse[]): ReadonlyMap<string, SourceUse[]> {
  const places = new Map<string, SourceUse[]>()
  for (const use of uses) {
    const start = parts.findIndex((part) => entryOfPart(part.id) === use.inputEntry)
    const place = start === -1 || use.sources.length === 0 ? undefined : answerOf(parts, start)
    if (place !== undefined) places.set(place, [...(places.get(place) ?? []), use])
  }
  return places
}

/** Whether a part starts the owner's next turn. */
const turnStarts = (part: Placed) => part.kind === 'user' || part.kind === 'persona-ask'

/** The last text of the turn the input at `start` began, or the input itself while no answer has come. */
function answerOf(parts: readonly Placed[], start: number): string | undefined {
  const end = parts.findIndex((part, index) => index > start && turnStarts(part))
  const turn = parts.slice(start + 1, end === -1 ? undefined : end)
  return turn.findLast((part) => part.kind === 'text')?.id ?? parts[start]?.id
}

/** The Topics a strip names in its line: each once, in the order the sources came. */
export const sourceTopics = (sources: readonly RetrievalSource[]): string[] => [
  ...new Set(sources.map((source) => source.topicName)),
]
