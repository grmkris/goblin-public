import { Schema } from 'effect'
import { Score, type EpisodeResult, type Resolved } from './results.ts'

export const Review = Schema.Struct({
  runId: Schema.String,
  corpusHash: Schema.String,
  episodeId: Schema.String,
  reviewer: Schema.String,
  rationale: Schema.String,
  evidenceIds: Schema.Array(Schema.String),
  classification: Schema.Array(
    Schema.Literals([
      'summary-omission',
      'summary-distortion',
      'retrieval-miss',
      'stale-state',
      'reader-reasoning',
      'data-redaction',
      'provider-runtime',
      'grader-ambiguity',
    ]),
  ),
  score: Score,
  at: Schema.String,
})
export type Review = typeof Review.Type

/** Manual prose review can refine semantic scores, but never override observed runtime or citation failures. */
export function applyReview(resolved: Resolved, result: EpisodeResult, review: Review): EpisodeResult {
  if (review.runId !== resolved.runId || review.corpusHash !== resolved.corpusHash || review.episodeId !== result.id)
    throw new Error('Review identity mismatch')
  const probe = resolved.scenarios
    ?.flatMap((scenario) => scenario.probes)
    .find((item) => result.id === `${item.id}.${result.variant}`)
  const scenario = resolved.scenarios?.find((item) => item.id === probe?.scenarioId)
  if (probe?.label === undefined || scenario === undefined) throw new Error('Review requires a real labeled probe')
  const allowed = new Set(scenario.events.slice(0, probe.cutoff).map((event) => event.id))
  if (review.evidenceIds.some((id) => !allowed.has(id))) throw new Error('Review evidence exceeds prefix')
  if (review.rationale.trim() === '' || review.reviewer.trim() === '')
    throw new Error('Review requires an identified reviewer and rationale')
  const score = {
    ...review.score,
    evidenceValid: review.score.evidenceValid && result.score.evidenceValid,
    abstentionCorrect: review.score.abstentionCorrect && result.score.abstentionCorrect,
    correct:
      review.score.correct &&
      result.status === 'completed' &&
      !result.malformed &&
      !result.futureLeakage &&
      !result.unauthorizedReads &&
      !result.forbiddenEndorsement &&
      result.score.evidenceValid &&
      result.score.abstentionCorrect &&
      review.score.evidenceComplete &&
      review.score.evidenceValid &&
      review.score.abstentionCorrect &&
      !review.score.unsupported,
  }
  return {
    ...result,
    score,
    reviewStatus: 'reviewed',
    review: {
      reviewer: review.reviewer,
      rationale: review.rationale,
      classification: review.classification,
    },
  }
}
