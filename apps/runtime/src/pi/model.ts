import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { stream, streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import type { Model } from '@earendil-works/pi-ai'
import type { RuntimeEnv } from '../env.ts'

type ModelEnvironment = Pick<RuntimeEnv, 'MODEL_ID' | 'MODEL_BASE_URL' | 'MODEL_KEY'>

/** The provider is configured at the Worker boundary; its key never enters Pi state. */
function makePiModel(env: ModelEnvironment): Model<'openai-completions'> {
  return {
    id: env.MODEL_ID,
    name: env.MODEL_ID,
    provider: 'purrable-litellm',
    api: 'openai-completions',
    baseUrl: env.MODEL_BASE_URL,
    input: ['text', 'image'],
    reasoning: false,
    contextWindow: 131_072,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

export function makePiModels(env: ModelEnvironment) {
  const model = makePiModel(env)
  const provider = createProvider({
    id: model.provider,
    name: 'Purrable LiteLLM',
    baseUrl: env.MODEL_BASE_URL,
    models: [model],
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
  return { models, model }
}
