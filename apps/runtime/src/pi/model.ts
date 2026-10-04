import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { stream, streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import type { Model } from '@earendil-works/pi-ai'
import type { ModelOption } from '@purrable/contracts'
import type { RuntimeEnv } from '../env.ts'
import { modelOptions } from '../models.ts'

type ModelEnvironment = Pick<RuntimeEnv, 'MODEL_ID' | 'MODEL_BASE_URL' | 'MODEL_KEY'> &
  Partial<Pick<RuntimeEnv, 'MODELS'>>

/** Every model is served by the deployment's LiteLLM under one provider id; `session.setModel` names it. */
export const MODEL_PROVIDER = 'purrable-litellm'

/** The provider is configured at the Worker boundary; its key never enters Pi state. */
function makePiModel(option: ModelOption, baseUrl: string): Model<'openai-completions'> {
  return {
    id: option.id,
    name: option.label,
    provider: MODEL_PROVIDER,
    api: 'openai-completions',
    baseUrl,
    input: option.images ? ['text', 'image'] : ['text'],
    reasoning: false,
    contextWindow: 131_072,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

/** Every offered model (`models.ts`), the default first; `model` is the default for new sessions. */
export function makePiModels(env: ModelEnvironment) {
  const options = modelOptions(env.MODELS, env.MODEL_ID)
  const [first, ...rest] = options
  const model = makePiModel(first, env.MODEL_BASE_URL)
  const others = rest.map((option) => makePiModel(option, env.MODEL_BASE_URL))
  const provider = createProvider({
    id: MODEL_PROVIDER,
    name: 'Purrable LiteLLM',
    baseUrl: env.MODEL_BASE_URL,
    models: [model, ...others],
    auth: {
      apiKey: {
        name: 'Purrable model key',
        resolve: async () => ({ auth: { apiKey: env.MODEL_KEY } }),
      },
    },
    api: { stream, streamSimple },
  })
  const models = createModels()
  models.setProvider(provider)
  return { models, model, options }
}
