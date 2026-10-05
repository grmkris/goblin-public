import * as Schema from 'effect/Schema'

const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.:-]+$/u))
const Positive = Schema.Int.check(Schema.isGreaterThan(0))
export const Policy = Schema.Literals(['optchat', 'standard', 'standard-search'])
export const Category = Schema.Literals([
  'latest-state',
  'rationale',
  'evidence',
  'negative-constraint',
  'synthesis',
  'abstention',
])

export const Fact = Schema.Struct({
  key: Id,
  value: Schema.String,
  authority: Schema.Literals(['owner', 'observation', 'claim', 'proposal']),
})
export const SourceEvent = Schema.Struct({
  id: Id,
  kind: Schema.Literals(['user', 'assistant', 'tool-call', 'tool-result']),
  text: Schema.String,
  callId: Schema.optional(Id),
  toolName: Schema.optional(Id),
  fact: Schema.optional(Fact),
})
export type SourceEvent = typeof SourceEvent.Type

/** Questions carry no answer key; the evaluator retains the fact ledger on the host. */
export const Probe = Schema.Struct({
  id: Id,
  scenarioId: Id,
  cutoff: Positive,
  category: Category,
  question: Schema.String,
  keys: Schema.Array(Id),
})
export type Probe = typeof Probe.Type

export const Scenario = Schema.Struct({
  id: Id,
  family: Id,
  split: Schema.Literals(['development', 'held-out']),
  events: Schema.Array(SourceEvent),
  probes: Schema.Array(Probe),
})
export type Scenario = typeof Scenario.Type

export const Variant = Schema.Struct({
  id: Id,
  policy: Policy,
  writer: Schema.optional(Schema.String),
  reader: Schema.String,
})
export type Variant = typeof Variant.Type

export const Manifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  name: Id,
  split: Schema.Literals(['development', 'held-out']),
  profile: Schema.Literals(['controlled', 'production-compatibility']),
  scenarioIds: Schema.Array(Id),
  variants: Schema.Array(Variant),
  pressure: Schema.Struct({
    contextWindowTokens: Positive,
    reserveTokens: Positive,
    keepRecentTokens: Positive,
    viewBytes: Positive,
  }),
  allowance: Schema.Struct({
    maxAnswers: Positive,
    maxRequests: Positive,
    maxInputTokens: Positive,
    maxOutputTokens: Positive,
    concurrency: Positive.check(Schema.isLessThanOrEqualTo(2)),
  }),
  retrieval: Schema.Struct({ maxCalls: Positive, maxBytes: Positive }),
  buildTrial: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  summaryPrompt: Schema.NullOr(Schema.String),
  recallGuide: Schema.NullOr(Schema.String),
  rates: Schema.Array(
    Schema.Struct({
      model: Schema.String,
      inputPerMillion: Schema.Number,
      outputPerMillion: Schema.Number,
      dated: Schema.String,
    }),
  ),
})
export type Manifest = typeof Manifest.Type

export const Claim = Schema.Struct({ key: Id, value: Schema.String })
export const Answer = Schema.Struct({
  claims: Schema.Array(Claim),
  evidenceIds: Schema.Array(Id),
  abstain: Schema.Boolean,
})
export type Answer = typeof Answer.Type
