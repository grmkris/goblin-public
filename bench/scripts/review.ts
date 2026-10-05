import { Effect, Schema } from 'effect'
import { join } from 'node:path'
import { applyReview, Review } from '../src/review.ts'
import { loadRun } from './runner.ts'
import { appendJson, fail, lockRun, readJson } from './store.ts'

export const recordReviews = Effect.fn('bench.recordReviews')(function* (dir: string, path: string) {
  yield* lockRun(dir)
  const data = yield* loadRun(dir)
  const reviews = yield* readJson(path, Schema.Array(Review))
  const seen = new Set<string>()
  for (const review of reviews) {
    if (seen.has(review.episodeId)) return yield* fail('Duplicate review episode in batch')
    seen.add(review.episodeId)
    const result = data.results.find((item) => item.id === review.episodeId)
    if (result === undefined) return yield* fail('Review references an unexecuted episode')
    yield* Effect.try({
      try: () => applyReview(data.resolved, result, review),
      catch: () => fail('Invalid review identity, evidence, or rationale'),
    })
  }
  for (const review of reviews) yield* appendJson(join(dir, 'reviews.jsonl'), review)
  return { reviewed: reviews.length }
})
