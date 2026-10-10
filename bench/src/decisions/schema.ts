import { Schema } from 'effect'
import { tasks, Answers, ContextState, BriefState, AttentionState, WorkState } from '@goblin/runtime/decisions'
export { tasks, Answers }
export type { Task, Usage } from '@goblin/runtime/decisions'

export const arms = ['rules', 'critic', 'cheap-llm', 'clef', 'clef-flash', 'jev', 'openai-decisions'] as const
export type Arm = (typeof arms)[number]
const labels = {
  id: Schema.String,
  category: Schema.Literals(['ordinary', 'ambiguous', 'contradictory', 'missing-evidence', 'stale', 'do-nothing']),
  expected: Schema.Record(Schema.String, Schema.String),
  rationale: Schema.String,
}
export const Fixture = Schema.Union([
  Schema.Struct({ ...labels, task: Schema.Literal('context-relevance'), state: ContextState }),
  Schema.Struct({ ...labels, task: Schema.Literal('brief-update'), state: BriefState }),
  Schema.Struct({ ...labels, task: Schema.Literal('attention-triage'), state: AttentionState }),
  Schema.Struct({ ...labels, task: Schema.Literal('separate-work'), state: WorkState }),
])
export type Fixture = typeof Fixture.Type
export const Row = Schema.Struct({
  id: Schema.String,
  arm: Schema.Literals(arms),
  task: Schema.Literals(tasks),
  repetition: Schema.Int,
  answers: Schema.NullOr(Answers),
  route: Schema.Literals(['rules', 'model', 'skipped']),
  error: Schema.NullOr(Schema.String),
  latencyMs: Schema.Number,
  input: Schema.Int,
  output: Schema.Int,
  costUsd: Schema.Number,
  actualCostUsd: Schema.NullOr(Schema.Number),
})
export type Row = typeof Row.Type
export const Attempt = Schema.Struct({
  id: Schema.String,
  runId: Schema.String,
  arm: Schema.Literals(arms),
  fixtureId: Schema.String,
  repetition: Schema.Int,
  phase: Schema.Literals(['reserve', 'settle']),
  reservedInput: Schema.Int,
  reservedOutput: Schema.Int,
  input: Schema.Int,
  output: Schema.Int,
  costUsd: Schema.Number,
  status: Schema.Int,
  error: Schema.NullOr(Schema.String),
  usageKnown: Schema.Boolean,
  latencyMs: Schema.Number,
  ownerApproved: Schema.optional(Schema.String),
  campaignId: Schema.optional(Schema.String),
})
export type Attempt = typeof Attempt.Type
