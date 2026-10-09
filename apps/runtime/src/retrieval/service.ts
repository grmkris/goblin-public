import type { RetrievalSource, SourceUse } from '@goblin/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import type { TextCompletion } from '../memory/model.ts'
import { AUTO_CANDIDATES, chooseSources, gateFor } from './auto.ts'
import type { TranscriptIndex } from './index.ts'

/** Most sources a `search_chats` call returns (`SourcesDetails`). */
const TOOL_SOURCES = 5

/** What `search_chats` looks for: words, and a Topic when one is named. */
export type SearchInput = { readonly query: string; readonly topic?: number }
/** Where a `search_chats` call ran: its session, the chat that session is, and the call's stable use id. */
export type SearchPlace = { readonly session: string; readonly chat?: string; readonly useId: string }
/** The chat automatic retrieval serves, and the session it runs in. */
export type AutoPlace = { readonly session: string; readonly chat: string }
/** An owner input as the index keeps it: its entry id and its indexed text. */
export type IndexedInput = { readonly entry: number; readonly text: string }

/**
 * Cross-Topic retrieval (ADR 0035): the transcript index, `search_chats` and automatic retrieval with the cheap model's
 * rerank (`AuxPurpose 'retrieval'`, metered into the daily budget by the model's own `spent` callback). Nothing here
 * holds a transaction across a Pi read or a model call.
 */
export class ChatRetrieval {
  readonly index: TranscriptIndex
  readonly #model: TextCompletion
  readonly #now: () => number

  constructor(index: TranscriptIndex, model: TextCompletion, now: () => number) {
    this.index = index
    this.#model = model
    this.#now = now
  }

  /**
   * `search_chats`: the frozen result of call `useId` when it ran before (a replay), else a bounded catch-up, the search
   * and its record. Without `topic` the default Topics are searched; a named one alone, whatever its state.
   */
  async search(input: SearchInput, where: SearchPlace): Promise<readonly RetrievalSource[]> {
    const prior = this.index.recorded(where.useId)
    if (prior !== undefined) return prior.sources
    await this.index.catchUpAll()
    const sources = this.index.search(input.query, {
      ...(where.chat === undefined ? {} : { exclude: where.chat }),
      ...(input.topic === undefined ? {} : { topic: input.topic }),
      limit: TOOL_SOURCES,
    })
    if (where.chat === undefined) return sources
    return this.index.record({
      id: where.useId,
      chat: where.chat,
      session: where.session,
      mode: 'tool',
      sources,
      retrievedAt: this.#now(),
    }).sources
  }

  /**
   * Automatic retrieval for the owner input `input` of `chat`: FTS over the default Topics (never this chat), the bm25
   * gate, then the cheap model's rerank, which may abstain. A selection is recorded as the input's use and returned.
   */
  async automatic(where: AutoPlace, input: IndexedInput, signal?: AbortSignal): Promise<SourceUse | undefined> {
    await this.index.catchUpAll()
    const candidates = this.index.search(input.text, { exclude: where.chat, limit: AUTO_CANDIDATES })
    if (candidates.length === 0) return undefined
    const chosen = await chooseSources(input.text, candidates, gateFor(this.index.size()), this.#model, signal)
    if (chosen.length === 0) return undefined
    return this.index.record({
      id: autoUseId(where.session, input.entry),
      chat: where.chat,
      session: where.session,
      inputEntry: input.entry,
      mode: 'auto',
      sources: chosen,
      retrievedAt: this.#now(),
    })
  }
}

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
