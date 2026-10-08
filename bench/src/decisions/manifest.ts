import { Schema } from 'effect'
import { arms } from './schema.ts'

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
export const Manifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  runId: Schema.String,
  fixtureHash: Schema.String,
  sourceHash: Schema.String,
  repetitions: Positive.check(Schema.isLessThanOrEqualTo(3)),
  batchSize: Schema.Literal(2),
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
      keyEnv: 'CLOUDFLARE_AI_TOKEN',
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
      keyEnv: 'CLOUDFLARE_AI_TOKEN',
      inputPerMillion: 0.09,
      outputPerMillion: 0,
      priced: true,
      dated: '2026-10-08',
      priceSource: 'https://developers.cloudflare.com/workers-ai/models/clef-flash/',
    },
    {
      arm: 'jev',
      model: 'typesafe-ai/jev',
      endpoint: 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model',
      keyEnv: 'AI_GATEWAY_API_KEY',
      inputPerMillion: 0.042,
      outputPerMillion: 0,
      priced: true,
      dated: '2026-10-08',
      priceSource: 'https://ai-gateway.vercel.sh/v1/models',
    },
    {
      arm: 'openai-decisions',
      model: 'gpt-6-luna',
      endpoint: 'http://127.0.0.1:8317/v1/decisions',
      keyEnv: 'CLIPROXY_API_KEY',
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
