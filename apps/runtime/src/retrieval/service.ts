import type { RetrievalSource, SourceUse } from '@goblin/contracts'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import { epochSeconds } from '../clock.ts'
import { type AppError, attempt, attemptSync } from '../http/errors.ts'
import type { TextCompletion } from '../memory/model.ts'
import type { KeyedLock } from '../observability/lock.ts'
import { AUTO_CANDIDATES, chooseSources, gateFor } from './auto.ts'
import {
  type TranscriptSource,
  catchUpTranscript,
  chatForSession,
  indexSize,
  latestInput,
  reassignExcerpts,
  recordUse,
  recordedUse,
  recordedUses,
  searchTranscripts,
} from './index.ts'
import { chatsToIndex, topicByName } from './sql.ts'

/** Most sources a `search_chats` call returns (`SourcesDetails`). */
const TOOL_SOURCES = 5
/** Entries one catch-up reads at most: of one session after a response, or of all chats together before a search. */
const CATCH_UP_ENTRIES = 400

/** What `search_chats` looks for: words, and a Topic when one is named. */
type SearchInput = { readonly query: string; readonly topic?: number }
/** Where a `search_chats` call ran: its session, the chat that session is, and the call's stable use id. */
type SearchPlace = { readonly session: string; readonly chat?: string; readonly useId: string }
/** The chat automatic retrieval serves, and the session it runs in. */
type AutoPlace = { readonly session: string; readonly chat: string }
/** An owner input as the index keeps it: its entry id and its indexed text. */
type IndexedInput = { readonly entry: number; readonly text: string }

/** The stable id of the automatic retrieval for one input of one session. */
export const autoUseId = (session: string, entry: number): string => `auto:${session}:${entry}`

/**
 * Cross-Topic retrieval (ADR 0035) as the agent's programs use it: `search_chats`, automatic retrieval, the transcript
 * index's catch-up and reads, the uses each chat recorded, and a Move's reassignment of entries to their new chat.
 */
export class Retrieval extends Context.Service<
  Retrieval,
  {
    /** `search_chats`: a replay's frozen result, else a bounded catch-up, the search and its record. */
    readonly search: (input: SearchInput, where: SearchPlace) => Effect.Effect<readonly RetrievalSource[], AppError>
    /** Automatic retrieval for an owner input: the recorded use when the rerank chose sources, else none. */
    readonly automatic: (
      where: AutoPlace,
      input: IndexedInput,
      signal?: AbortSignal,
    ) => Effect.Effect<SourceUse | undefined, AppError>
    /** Indexes `session`'s new entries, a bounded number at a time: `more` when some are left. */
    readonly catchUp: (session: string) => Effect.Effect<'more' | 'done', AppError>
    /** The chat `session` is registered as, and whether it is a Persona's fork; none for an unknown session. */
    readonly chatFor: (
      session: string,
    ) => Effect.Effect<{ readonly chat: string; readonly persona: boolean } | undefined>
    /** The Topic a name or id names, archived ones included. */
    readonly topicNamed: (name: string) => Effect.Effect<number | undefined>
    /** The newest owner input among `session`'s last entries, as the index keeps it. */
    readonly latestInput: (session: string) => Effect.Effect<IndexedInput | undefined, AppError>
    /** The use recorded under `id`, if any. */
    readonly recorded: (id: string) => Effect.Effect<SourceUse | undefined>
    /** The chat's recorded uses that found something, newest first: its answers' source strips. */
    readonly uses: (chat: string) => Effect.Effect<readonly SourceUse[]>
    /** Entries of `session` from `fromEntry` on now belong to `chat` (Move to thread). */
    readonly reassign: (session: string, fromEntry: number, chat: string) => Effect.Effect<void>
  }
>()('goblin/retrieval/Retrieval') {}

/**
 * What retrieval works with: the agent's database (the index and the uses), Pi's transcripts as the index reads them,
 * and the cheap model that reranks automatic retrieval (`AuxPurpose 'retrieval'`, metered into the daily budget by the
 * model's own `spent` callback). Nothing holds a transaction across a Pi read or a model call.
 */
export type RetrievalDeps = {
  readonly db: SQLiteAsyncDatabase<'sync', unknown>
  readonly source: TranscriptSource
  readonly model: TextCompletion
}

/**
 * Catches up `session`'s entries under its turn of `lock`, so two catch-ups of one session never read the same
 * windows at once, whoever asks (a response, a search, automatic retrieval). Once started, a catch-up runs to its end,
 * so whoever comes next never overlaps it. At most `maxEntries` entries; `more` when some are left.
 */
export const catchUpSession = (
  { db, source }: Pick<RetrievalDeps, 'db' | 'source'>,
  lock: KeyedLock['Service'],
  session: string,
  maxEntries = CATCH_UP_ENTRIES,
): Effect.Effect<{ readonly more: boolean; readonly read: number }, AppError> =>
  lock.withLock(`retrieval:${session}`)(
    Effect.uninterruptible(
      Effect.flatMap(epochSeconds, (now) => attempt(() => catchUpTranscript(db, source, session, { maxEntries, now }))),
    ),
  )

/**
 * A bounded catch-up of every chat that may have new entries, stalest first, before a search: about `budget` entries
 * in all. The rest follows on later searches and responses.
 */
export const catchUpChats = Effect.fn('Retrieval.catchUpChats')(function* (
  deps: Pick<RetrievalDeps, 'db' | 'source'>,
  lock: KeyedLock['Service'],
  budget: number = CATCH_UP_ENTRIES,
) {
  let left = budget
  for (const session of yield* attemptSync(() => chatsToIndex(deps.db))) {
    if (left <= 0) return
    const { read } = yield* catchUpSession(deps, lock, session, left)
    left -= Math.max(1, read)
  }
})

/**
 * `search_chats` over the index as it is (the service catches it up first): the frozen result of call `useId` when it
 * ran before (a replay), else the search and its record. Without `topic` the default Topics are searched; a named one
 * alone, whatever its state.
 */
const searchRecorded = (
  db: RetrievalDeps['db'],
  input: SearchInput,
  where: SearchPlace,
  now: number,
): readonly RetrievalSource[] => {
  const prior = recordedUse(db, where.useId)
  if (prior !== undefined) return prior.sources
  const sources = searchTranscripts(
    db,
    input.query,
    {
      ...(where.chat === undefined ? {} : { exclude: where.chat }),
      ...(input.topic === undefined ? {} : { topic: input.topic }),
      limit: TOOL_SOURCES,
    },
    now,
  )
  if (where.chat === undefined) return sources
  const use = { id: where.useId, chat: where.chat, session: where.session, sources, retrievedAt: now }
  return recordUse(db, { ...use, mode: 'tool' }).sources
}

/**
 * Automatic retrieval for the owner input `input` of `chat`, over the index as it is (the service catches it up
 * first): FTS over the default Topics (never this chat), the bm25 gate, then the cheap model's rerank, which may
 * abstain. A selection is recorded as the input's use and returned.
 */
const automaticRecorded = async (
  { db, model }: RetrievalDeps,
  where: AutoPlace,
  input: IndexedInput & { readonly now: number },
  signal?: AbortSignal,
): Promise<SourceUse | undefined> => {
  const candidates = searchTranscripts(db, input.text, { exclude: where.chat, limit: AUTO_CANDIDATES }, input.now)
  if (candidates.length === 0) return undefined
  const chosen = await chooseSources(input.text, candidates, gateFor(indexSize(db)), model, signal)
  if (chosen.length === 0) return undefined
  return recordUse(db, {
    id: autoUseId(where.session, input.entry),
    chat: where.chat,
    session: where.session,
    inputEntry: input.entry,
    mode: 'auto',
    sources: chosen,
    retrievedAt: input.now,
  })
}

/**
 * The Retrieval service over `deps` and the agent's `KeyedLock`: a search or automatic retrieval catches the index up
 * first, every catch-up under its session's turn. Failures arrive as `AppError`.
 */
export const retrievalOver = (deps: RetrievalDeps, lock: KeyedLock['Service']): Retrieval['Service'] => {
  const { db, source } = deps
  return Retrieval.of({
    search: Effect.fn('Retrieval.search')(function* (input: SearchInput, where: SearchPlace) {
      const prior = yield* attemptSync(() => recordedUse(db, where.useId))
      if (prior !== undefined) return prior.sources
      yield* catchUpChats(deps, lock)
      const now = yield* epochSeconds
      return yield* attemptSync(() => searchRecorded(db, input, where, now))
    }),
    automatic: Effect.fn('Retrieval.automatic')(function* (
      where: AutoPlace,
      input: IndexedInput,
      signal?: AbortSignal,
    ) {
      yield* catchUpChats(deps, lock)
      const now = yield* epochSeconds
      return yield* attempt(() => automaticRecorded(deps, where, { ...input, now }, signal))
    }),
    catchUp: Effect.fn('Retrieval.catchUp')(function* (session: string) {
      return (yield* catchUpSession(deps, lock, session)).more ? ('more' as const) : ('done' as const)
    }),
    chatFor: Effect.fn('Retrieval.chatFor')(function* (session: string) {
      return yield* Effect.sync(() => chatForSession(db, session))
    }),
    topicNamed: Effect.fn('Retrieval.topicNamed')(function* (name: string) {
      return yield* Effect.sync(() => topicByName(db, name))
    }),
    latestInput: Effect.fn('Retrieval.latestInput')(function* (session: string) {
      const now = yield* epochSeconds
      return yield* attempt(() => latestInput(source, session, now))
    }),
    recorded: Effect.fn('Retrieval.recorded')(function* (id: string) {
      return yield* Effect.sync(() => recordedUse(db, id))
    }),
    uses: Effect.fn('Retrieval.uses')(function* (chat: string) {
      return yield* Effect.sync(() => recordedUses(db, chat))
    }),
    reassign: Effect.fn('Retrieval.reassign')(function* (session: string, fromEntry: number, chat: string) {
      yield* Effect.sync(() => reassignExcerpts(db, session, fromEntry, chat))
    }),
  })
}
