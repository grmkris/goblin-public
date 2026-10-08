import { redactedExcerpt } from './retrieval-excerpt.ts'
import type { RetrievalLabel, TranscriptMessage } from './retrieval-corpus.ts'

export type Ranked = { readonly entryId: number; readonly score: number }
export type EvidenceSource = {
  readonly chatId: string
  readonly sessionId: string
  readonly entryStart: number
  readonly entryEnd: number
  readonly excerpt: string
  readonly retrievedAt: number
  readonly indexRevision: string
  readonly score: number
}

const matches = (target: RetrievalLabel['targets'][number], row: Ranked) =>
  row.entryId >= target.start && row.entryId <= target.end

/** Recall counts distinct labelled ranges, so multiple hits in one range cannot inflate it. */
export function queryMetrics(label: RetrievalLabel, rows: readonly Ranked[]) {
  const recall = (k: number) =>
    label.targets.length === 0
      ? null
      : label.targets.filter((target) => rows.slice(0, k).some((row) => matches(target, row))).length /
        label.targets.length
  const relevant = rows.filter((row) => label.targets.some((target) => matches(target, row)))
  const first = rows.findIndex((row) => label.targets.some((target) => matches(target, row)))
  return {
    recallAt5: recall(5),
    recallAt10: recall(10),
    mrr: label.targets.length === 0 ? null : first < 0 ? 0 : 1 / (first + 1),
    precision: rows.length === 0 ? null : relevant.length / rows.length,
    noneCorrect: label.targets.length === 0 ? rows.length === 0 : null,
  }
}

export function sourceFor(
  message: TranscriptMessage,
  score: number,
  indexRevision: string,
  retrievedAt: number,
): EvidenceSource {
  return {
    chatId: message.chatId,
    sessionId: message.sessionId,
    entryStart: message.entryId,
    entryEnd: message.entryId,
    excerpt: redactedExcerpt(message.text),
    retrievedAt,
    indexRevision,
    score,
  }
}

/** Escape each literal token before OR matching: user input cannot become FTS query syntax. */
export function ftsQuery(query: string): string {
  return [...new Set(query.match(/[\p{L}\p{N}]+/gu) ?? [])]
    .slice(0, 32)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(' OR ')
}
