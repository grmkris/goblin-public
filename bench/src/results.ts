import { Schema } from 'effect'
import { Answer, Category, Manifest } from './schema.ts'

export const Score = Schema.Struct({
  correct: Schema.Boolean,
  evidenceComplete: Schema.Boolean,
  evidenceValid: Schema.Boolean,
  abstentionCorrect: Schema.Boolean,
  unsupported: Schema.Boolean,
})
export const EpisodeResult = Schema.Struct({
  id: Schema.String,
  variant: Schema.String,
  category: Category,
  status: Schema.Literals(['completed', 'failed']),
  answer: Schema.NullOr(Answer),
  score: Score,
  malformed: Schema.Boolean,
  futureLeakage: Schema.Boolean,
  unauthorizedReads: Schema.Boolean,
  forbiddenEndorsement: Schema.Boolean,
  deliveredIds: Schema.Array(Schema.String),
  detail: Schema.String,
})
export type EpisodeResult = typeof EpisodeResult.Type
export const Resolved = Schema.Struct({
  manifest: Manifest,
  sourceHash: Schema.String,
  corpusHash: Schema.String,
  runId: Schema.String,
  mode: Schema.Literals(['fake', 'live']),
  createdAt: Schema.String,
})
export type Resolved = typeof Resolved.Type
export type RunData = {
  readonly resolved: Resolved
  readonly results: readonly EpisodeResult[]
  readonly traces: readonly Trace[]
}
export const Trace = Schema.Struct({
  scope: Schema.String,
  model: Schema.String,
  phase: Schema.Literals(['build', 'answer']),
  attempt: Schema.Int,
  status: Schema.Int,
  input: Schema.Number,
  output: Schema.Number,
  unknownUsage: Schema.Boolean,
  request: Schema.String,
  response: Schema.String,
  at: Schema.String,
})
export type Trace = typeof Trace.Type
