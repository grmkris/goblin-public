import { Schema } from 'effect'
import { Scenario } from './schema.ts'

export const Corpus = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: Schema.String,
  kind: Schema.Literals(['claude-jsonl', 'hermes-sqlite-export']),
  sourceHash: Schema.String,
  redactedHash: Schema.String,
  sourceLines: Schema.Int,
  checkpoints: Schema.Array(
    Schema.Struct({ target: Schema.Int, cutoff: Schema.Int, estimatedTokens: Schema.Int, line: Schema.Int }),
  ),
  compactBoundaries: Schema.Array(Schema.Int),
  omissions: Schema.Array(
    Schema.Struct({ line: Schema.Int, block: Schema.optional(Schema.Int), reason: Schema.String }),
  ),
  scenarios: Schema.Array(Scenario),
})
export type Corpus = typeof Corpus.Type
