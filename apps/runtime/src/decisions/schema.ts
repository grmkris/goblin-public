import { Schema } from 'effect'

export const tasks = ['context-relevance', 'brief-update', 'attention-triage', 'separate-work'] as const
export type Task = (typeof tasks)[number]
const Probability = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const Distribution = Schema.Record(Schema.String, Probability)
const Message = Schema.Struct({ role: Schema.Literals(['owner', 'assistant', 'report']), text: Schema.String })
const Named = Schema.Struct({ id: Schema.String, name: Schema.String })

export const ContextState = Schema.Struct({
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
export const BriefState = Schema.Struct({ exchange: Schema.Array(Message), brief: Schema.Array(Schema.String) })
export const AttentionState = Schema.Struct({
  focus: Schema.String,
  result: Schema.String,
  runtimeKind: Schema.Literals(['delegate-result', 'thread-update']),
})
export const WorkState = Schema.Struct({
  currentTopic: Schema.String,
  currentThread: Schema.String,
  exchange: Schema.Array(Message),
  topics: Schema.Array(Named),
  threads: Schema.Array(Named),
})
export const DecisionCase = Schema.Union([
  Schema.Struct({ task: Schema.Literal('context-relevance'), id: Schema.String, state: ContextState }),
  Schema.Struct({ task: Schema.Literal('brief-update'), id: Schema.String, state: BriefState }),
  Schema.Struct({ task: Schema.Literal('attention-triage'), id: Schema.String, state: AttentionState }),
  Schema.Struct({ task: Schema.Literal('separate-work'), id: Schema.String, state: WorkState }),
])
export type DecisionCase = typeof DecisionCase.Type
export type ContextState = typeof ContextState.Type
export type BriefState = typeof BriefState.Type
export type AttentionState = typeof AttentionState.Type
export type WorkState = typeof WorkState.Type

export interface Question {
  readonly type: 'noul' | 'choice' | 'score'
  readonly instructions: string
  readonly options: readonly string[]
  readonly criteria: Readonly<Record<string, string>> | readonly string[]
}
export type Questions = Readonly<Record<string, Question>>
export type Answers = Readonly<Record<string, Readonly<Record<string, number>>>>
export const Answers = Schema.Record(Schema.String, Distribution)
export const Usage = Schema.Struct({ input: Schema.Int, output: Schema.Int })
export type Usage = typeof Usage.Type
