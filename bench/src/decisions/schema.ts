import { Schema } from 'effect'

export const tasks = ['context-relevance', 'brief-update', 'attention-triage', 'separate-work'] as const
export const arms = ['rules', 'critic', 'cheap-llm', 'clef', 'clef-flash', 'jev', 'openai-decisions'] as const
export type Task = (typeof tasks)[number]
export type Arm = (typeof arms)[number]
const Probability = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const Distribution = Schema.Record(Schema.String, Probability)
const Message = Schema.Struct({ role: Schema.Literals(['owner', 'assistant', 'report']), text: Schema.String })
const Named = Schema.Struct({ id: Schema.String, name: Schema.String })

const ContextState = Schema.Struct({
  request: Schema.String,
  explicitReferences: Schema.Array(Schema.String),
  candidates: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      topic: Schema.String,
      excerpt: Schema.String,
      autoEnabled: Schema.Boolean,
      archived: Schema.Boolean,
      supersededBy: Schema.NullOr(Schema.String),
    }),
  ),
})
const BriefState = Schema.Struct({ exchange: Schema.Array(Message), brief: Schema.Array(Schema.String) })
const AttentionState = Schema.Struct({
  focus: Schema.String,
  result: Schema.String,
  runtimeKind: Schema.Literals(['delegate-result', 'thread-update']),
})
const WorkState = Schema.Struct({
  currentTopic: Schema.String,
  currentThread: Schema.String,
  exchange: Schema.Array(Message),
  topics: Schema.Array(Named),
  threads: Schema.Array(Named),
})
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
export interface Question {
  readonly type: 'noul' | 'choice' | 'score'
  readonly instructions: string
  readonly options: readonly string[]
  readonly criteria: Readonly<Record<string, string>> | readonly string[]
}
export type Questions = Readonly<Record<string, Question>>
export type Answers = Readonly<Record<string, Readonly<Record<string, number>>>>
export const Answers = Schema.Record(Schema.String, Distribution)

const Usage = Schema.Struct({ input: Schema.Int, output: Schema.Int })
export type Usage = typeof Usage.Type
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
})
export type Attempt = typeof Attempt.Type
