import { CONTEXT_SOURCES, type RetrievalSource } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import { epochSeconds } from '../clock.ts'
import { attempt, attemptSync } from '../http/errors.ts'
import type { KeyedLock } from '../observability/lock.ts'
import { chatForSession, latestInput, recordedUse, searchTranscripts } from '../retrieval/index.ts'
import { type RetrievalDeps, autoUseId, catchUpChats } from '../retrieval/service.ts'
import { sourcesText } from '../retrieval/text.ts'
import type { DecisionCase } from './schema.ts'

/** The transcript index (ADR 0035) as context relevance reads it: the agent's database, and Pi's transcripts. */
export type IndexDeps = Pick<RetrievalDeps, 'db' | 'source'>

/** The owner's newest message in a chat and the earlier work a search found for it in the owner's other chats. */
export type ContextCandidates = {
  readonly input: { readonly entry: number; readonly text: string }
  readonly sources: readonly [RetrievalSource, ...RetrievalSource[]]
}

/** How many search results are weighed before those automatic retrieval already gave are set aside. */
const SEARCHED = 8

/** Whether two sources cover any of the same messages of one chat. */
const overlaps = (a: RetrievalSource, b: RetrievalSource) =>
  a.chat === b.chat && a.entryStart <= b.entryEnd && b.entryStart <= a.entryEnd

/**
 * Cross-Topic context candidates for the owner's newest message in `chat` (ADR 0035's index, its default Topic policy:
 * active Topics that take part in search, never the chat itself): after a bounded catch-up, the top three sources of a
 * search for that message that automatic retrieval did not already give it (`auto:<session>:<entry>`). None for a
 * Persona fork, a chat without an owner message, or nothing left.
 */
export const contextCandidates = Effect.fn('decisions.contextCandidates')(function* (
  index: IndexDeps,
  lock: KeyedLock['Service'],
  session: string,
  chat: string,
) {
  const { db, source } = index
  if ((yield* attemptSync(() => chatForSession(db, session)))?.persona !== false) return undefined
  const input = yield* Effect.flatMap(epochSeconds, (now) => attempt(() => latestInput(source, session, now)))
  if (input === undefined) return undefined
  yield* catchUpChats(index, lock)
  const now = yield* epochSeconds
  const fresh = yield* attemptSync(() => {
    const given = recordedUse(db, autoUseId(session, input.entry))?.sources ?? []
    return searchTranscripts(db, input.text, { exclude: chat, limit: SEARCHED }, now).filter(
      (found) => !given.some((used) => overlaps(found, used)),
    )
  })
  const [first, ...rest] = fresh.slice(0, CONTEXT_SOURCES)
  return first === undefined ? undefined : ({ input, sources: [first, ...rest] } satisfies ContextCandidates)
})

/**
 * The critic's case: is each candidate directly useful to the request, or none? The default search already leaves out
 * archived and opted-out Topics, and the owner named none, so every candidate is automatic, active and current.
 */
export function contextCase(
  request: string,
  sources: readonly RetrievalSource[],
): Extract<DecisionCase, { readonly task: 'context-relevance' }> {
  return {
    id: 'context',
    task: 'context-relevance',
    state: {
      request: request.slice(0, 2000),
      explicitReferences: [],
      candidates: sources.map((source, index) => ({
        id: `c${index + 1}`,
        topic: source.topicName,
        excerpt: source.excerpt,
        autoEnabled: true,
        archived: false,
        supersededBy: null,
      })),
    },
  }
}

/** The excerpts the owner chose to use, as goblin's note for a request: quoted history, never instructions. */
export const chosenText = (sources: readonly RetrievalSource[]): string =>
  `The owner chose to use these excerpts from their other chats here.\n${sourcesText(sources)}`
