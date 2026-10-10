import { Schema } from 'effect'
import { arms, tasks } from './schema.ts'

const Nonnegative = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
const Positive = Schema.Int.check(Schema.isGreaterThan(0))
export const Model = Schema.Struct({
  arm: Schema.Literals(arms),
  model: Schema.String,
  endpoint: Schema.String,
  keyEnv: Schema.String,
  inputPerMillion: Nonnegative,
  outputPerMillion: Nonnegative,
  priced: Schema.Boolean,
  dated: Schema.String,
  priceSource: Schema.String,
})
export type Model = typeof Model.Type
export const FrozenThresholds = Schema.Record(
  Schema.Literals(tasks),
  Schema.Record(
    Schema.Literals(arms),
    Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  ),
)
export type FrozenThresholds = typeof FrozenThresholds.Type
export function freezeThresholds(
  metrics: readonly { task: string; arm: string; threshold: { value: number } | null }[],
): FrozenThresholds {
  return Schema.decodeUnknownSync(FrozenThresholds)(
    Object.fromEntries(
      tasks.map((task) => [
        task,
        Object.fromEntries(
          arms.map((arm) => [
            arm,
            metrics.find((item) => item.task === task && item.arm === arm)?.threshold?.value ?? null,
          ]),
        ),
      ]),
    ),
  )
}
export const Manifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  runId: Schema.String,
  fixtureFile: Schema.optional(Schema.String),
  thresholdSource: Schema.optional(Schema.String),
  frozenThresholds: Schema.optional(FrozenThresholds),
  fixtureHash: Schema.String,
  sourceHash: Schema.String,
  campaign: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      maxUsd: Nonnegative.check(Schema.isLessThanOrEqualTo(3.5)),
    }),
  ),
  excludeRows: Schema.optional(
    Schema.Array(Schema.Struct({ id: Schema.String, arm: Schema.Literals(arms), repetition: Positive })),
  ),
  repetitions: Positive.check(Schema.isLessThanOrEqualTo(3)),
  batchSize: Schema.Literal(2),
  selectedArms: Schema.optional(Schema.Array(Schema.Literals(arms))),
  prompt: Schema.String,
  questions: Schema.JsonObject,
  models: Schema.Array(Model),
  limits: Schema.Struct({
    maxRequests: Positive.check(Schema.isLessThanOrEqualTo(2000)),
    maxUsd: Nonnegative.check(Schema.isLessThanOrEqualTo(3)),
    maxInput: Positive,
    maxOutput: Positive,
    perCallInput: Positive,
    perCallOutput: Positive,
  }),
})
export type Manifest = typeof Manifest.Type
export const activeArms = (manifest: Manifest) => manifest.selectedArms ?? arms

export function models(account: string): readonly Model[] {
  const cloud = 'https://api.cloudflare.com/client/v4/accounts/' + account + '/ai/run/@cf/cloudflare/'
  return [
    {
      arm: 'cheap-llm',
      model: 'qwen3.8-flash',
      endpoint: 'http://127.0.0.1:8317/v1/chat/completions',
      keyEnv: 'CLIPROXY_API_KEY',
      inputPerMillion: 1,
      outputPerMillion: 5,
      priced: false,
      dated: '2026-10-08',
      priceSource: 'Conservative budget rate; actual CLIProxy price unavailable',
    },
    {
      arm: 'clef',
      model: 'clef',
      endpoint: cloud + 'clef',
      keyEnv: 'CLOUDFLARE_API_TOKEN',
      inputPerMillion: 0.24,
      outputPerMillion: 0,
      priced: true,
      dated: '2026-10-08',
      priceSource: 'https://developers.cloudflare.com/workers-ai/models/clef/',
    },
    {
      arm: 'clef-flash',
      model: 'clef-flash',
      endpoint: cloud + 'clef-flash',
      keyEnv: 'CLOUDFLARE_API_TOKEN',
      inputPerMillion: 0.09,
      outputPerMillion: 0,
      priced: true,
      dated: '2026-10-08',
      priceSource: 'https://developers.cloudflare.com/workers-ai/models/clef-flash/',
    },
    {
      arm: 'jev',
      model: 'jev-1.13.0',
      endpoint: 'https://api.typesafe.ai/v1/systemone',
      keyEnv: 'JEV_API_KEY',
      inputPerMillion: 0.042,
      outputPerMillion: 0,
      priced: true,
      dated: '2026-10-08',
      priceSource: 'https://docs.typesafe.ai/models',
    },
    {
      arm: 'openai-decisions',
      model: 'gpt-6-luna',
      endpoint: 'https://api.openai.com/v1/decisions',
      keyEnv: 'OPENAI_DECISIONS_API_KEY',
      inputPerMillion: 0.1,
      outputPerMillion: 0,
      priced: true,
      dated: '2026-10-08',
      priceSource: 'https://developers.openai.com/api/docs/models/gpt-6-luna',
    },
  ]
}
export function modelFor(manifest: Manifest, arm: string): Model {
  const model = manifest.models.find((item) => item.arm === (arm === 'critic' ? 'clef' : arm))
  if (model === undefined) throw new Error('Manifest lacks requested model')
  return model
}
