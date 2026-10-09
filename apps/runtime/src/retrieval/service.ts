import type { RetrievalSource } from '@goblin/contracts'
import type { TranscriptIndex } from './index.ts'

/** Most sources a `search_chats` call returns (`SourcesDetails`). */
const TOOL_SOURCES = 5

/** Cross-Topic retrieval (ADR 0035): the transcript index and `search_chats`. Nothing here holds a transaction across a Pi read. */
export class ChatRetrieval {
  readonly index: TranscriptIndex
  readonly #now: () => number

  constructor(index: TranscriptIndex, now: () => number) {
    this.index = index
    this.#now = now
  }

  /**
   * `search_chats`: the frozen result of call `useId` when it ran before (a replay), else a bounded catch-up, the search
   * and its record. Without `topic` the default Topics are searched; a named one alone, whatever its state.
   */
  async search(
    input: { readonly query: string; readonly topic?: number },
    where: { readonly session: string; readonly chat?: string; readonly useId: string },
  ): Promise<readonly RetrievalSource[]> {
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
}
