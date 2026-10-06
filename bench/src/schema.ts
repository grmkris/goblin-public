import * as Schema from 'effect/Schema'

const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.:-]+$/u))
const Positive = Schema.Int.check(Schema.isGreaterThan(0))
const AllowanceLimits = Schema.Struct({
  maxRequests: Positive,
  maxInputTokens: Positive,
  maxOutputTokens: Positive,
})
export const Policy = Schema.Literals(['optchat', 'optchat-search', 'standard', 'standard-search'])
/** Retrieval changes answer policy, never the shared writer artifact. */
export const buildPolicy = (policy: typeof Policy.Type): 'optchat' | 'standard' =>
  policy === 'optchat' || policy === 'optchat-search' ? 'optchat' : 'standard'
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
  arguments: Schema.optional(Schema.JsonObject),
  timestamp: Schema.optional(Schema.Number),
  isError: Schema.optional(Schema.Boolean),
  groupId: Schema.optional(Schema.String),
  provenance: Schema.optional(
    Schema.Struct({
      line: Positive,
      block: Schema.Int,
      uuid: Schema.String,
      parentUuid: Schema.NullOr(Schema.String),
    }),
  ),
})
export type SourceEvent = typeof SourceEvent.Type

/** Questions carry no answer key; the evaluator retains the fact ledger on the host. */
const ClaimLabel = Schema.Struct({ key: Id, meaning: Schema.String })
export const Probe = Schema.Struct({
  id: Id,
  scenarioId: Id,
  cutoff: Positive,
  category: Category,
  question: Schema.String,
  keys: Schema.Array(Id),
  label: Schema.optional(
    Schema.Struct({
      requiredClaims: Schema.Array(ClaimLabel),
      evidenceIds: Schema.Array(Id),
      evidenceRanges: Schema.optional(
        Schema.Array(
          Schema.Struct({
            id: Id,
            offsetBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
            endBytes: Positive,
          }),
        ),
      ),
      mustAbstain: Schema.Boolean,
      prohibitedClaims: Schema.Array(Schema.String),
      rubric: Schema.String,
    }),
  ),
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
  campaignId: Schema.optional(Id),
  corpus: Schema.optional(Schema.Struct({ path: Schema.String, sha256: Schema.String })),
  split: Schema.Literals(['development', 'held-out']),
  transport: Schema.optional(
    Schema.Struct({
      contextWindowTokens: Positive,
      thinking: Schema.Literals(['provider-default', 'disabled']),
      readerMaxOutputTokens: Schema.optional(Positive.check(Schema.isLessThanOrEqualTo(8192))),
      nativeCompactionMaxOutputTokens: Schema.optional(Positive.check(Schema.isLessThanOrEqualTo(8192))),
    }),
  ),
  modelTransport: Schema.optional(
    Schema.Array(
      Schema.Struct({
        model: Schema.String,
        thinking: Schema.Literals(['provider-default', 'disabled']),
        contextWindowTokens: Positive,
        readerMaxOutputTokens: Positive.check(Schema.isLessThanOrEqualTo(8192)),
        nativeCompactionMaxOutputTokens: Positive.check(Schema.isLessThanOrEqualTo(8192)),
      }),
    ),
  ),
  profile: Schema.Literals(['controlled', 'production-compatibility']),
  replay: Schema.optional(Schema.Struct({ maxBatchBytes: Positive.check(Schema.isLessThanOrEqualTo(262144)) })),
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
    maxRequestsPerAnswer: Schema.optional(Positive.check(Schema.isLessThanOrEqualTo(8))),
    maxInputTokens: Positive,
    maxOutputTokens: Positive,
    concurrency: Positive.check(Schema.isLessThanOrEqualTo(2)),
    phases: Schema.optional(
      Schema.Struct({
        preflight: AllowanceLimits,
        build: AllowanceLimits,
        answer: AllowanceLimits,
        judge: Schema.optional(AllowanceLimits),
      }),
    ),
    stages: Schema.optional(
      Schema.Array(
        Schema.Struct({
          cutoff: Positive,
          build: AllowanceLimits,
          answer: AllowanceLimits,
          judge: Schema.optional(AllowanceLimits),
        }),
      ),
    ),
  }),
  retrieval: Schema.Struct({
    maxCalls: Positive,
    maxBytes: Positive,
    format: Schema.optional(Schema.Literal('compact-v2')),
  }),
  buildTrial: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  preflight: Schema.optional(
    Schema.Struct({
      scenarioId: Id,
      cutoff: Positive,
      sourceId: Id,
      query: Schema.String,
      maxRequests: Positive.check(Schema.isLessThanOrEqualTo(6)),
      maxInputTokens: Positive.check(Schema.isLessThanOrEqualTo(50_000)),
      maxOutputTokens: Positive.check(Schema.isLessThanOrEqualTo(10_000)),
    }),
  ),
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
