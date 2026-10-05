import { Schema } from 'effect'
import { Answer, Category, Manifest, Scenario } from './schema.ts'
import { Delivery, RetrievalRecord } from './protocol.ts'
import type { StageReceipt } from './stages.ts'
import type { SemanticVote } from './semantic.ts'

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
  rawAnswer: Schema.optional(Schema.String),
  score: Score,
  malformed: Schema.Boolean,
  futureLeakage: Schema.Boolean,
  unauthorizedReads: Schema.Boolean,
  forbiddenEndorsement: Schema.Boolean,
  deliveredIds: Schema.Array(Schema.String),
  deliveries: Schema.optional(Schema.Array(Delivery)),
  retrieval: Schema.optional(Schema.Array(RetrievalRecord)),
  detail: Schema.String,
  timing: Schema.optional(
    Schema.Struct({
      episodeMs: Schema.Number,
      buildMs: Schema.optional(Schema.Number),
      answerMs: Schema.optional(Schema.Number),
    }),
  ),
  reviewStatus: Schema.optional(Schema.Literals(['pending', 'reviewed'])),
  review: Schema.optional(
    Schema.Struct({
      reviewer: Schema.String,
      rationale: Schema.String,
      classification: Schema.Array(Schema.String),
      searchSupported: Schema.optional(Schema.Boolean),
    }),
  ),
})
export type EpisodeResult = typeof EpisodeResult.Type
export const Resolved = Schema.Struct({
  manifest: Manifest,
  sourceHash: Schema.String,
  scenarios: Schema.optional(Schema.Array(Scenario)),
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
  readonly semanticVotes?: readonly SemanticVote[]
  readonly stageReceipts?: readonly StageReceipt[]
}
export const Trace = Schema.Struct({
  scope: Schema.String,
  model: Schema.String,
  phase: Schema.Literals(['preflight', 'build', 'answer']),
  stage: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  attempt: Schema.Int,
  status: Schema.Int,
  input: Schema.Number,
  output: Schema.Number,
  unknownUsage: Schema.Boolean,
  request: Schema.String,
  response: Schema.String,
  at: Schema.String,
  retryIndex: Schema.optional(Schema.Int),
  latencyMs: Schema.optional(Schema.Number),
  responseModel: Schema.optional(Schema.String),
  responseId: Schema.optional(Schema.String),
  requestId: Schema.optional(Schema.String),
  reasoningTokens: Schema.optional(Schema.Number),
  cacheReadTokens: Schema.optional(Schema.Number),
  cacheWriteTokens: Schema.optional(Schema.Number),
  reservedInput: Schema.optional(Schema.Number),
  reservedOutput: Schema.optional(Schema.Number),
  reservationBreach: Schema.optional(Schema.Boolean),
})
export type Trace = typeof Trace.Type
