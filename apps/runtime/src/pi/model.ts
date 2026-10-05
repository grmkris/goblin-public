import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { stream, streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import type { Model, ProviderStreams } from '@earendil-works/pi-ai'
import type { ModelOption } from '@purrable/contracts'
import type { RuntimeEnv } from '../env.ts'
import { modelOptions } from '../models.ts'

type ModelEnvironment = Pick<RuntimeEnv, 'MODEL_ID' | 'MODEL_BASE_URL' | 'MODEL_KEY'> &
  Partial<Pick<RuntimeEnv, 'MODELS'>>

/** Every model is served by the deployment's LiteLLM under one provider id; `session.setModel` names it. */
export const MODEL_PROVIDER = 'purrable-litellm'

/** The provider is configured at the Worker boundary; its key never enters Pi state. */
function makePiModel(
  option: ModelOption,
  baseUrl: string,
  contextWindow?: number,
  provider = MODEL_PROVIDER,
): Model<'openai-completions'> {
  return {
    id: option.id,
    name: option.label,
    provider,
    api: 'openai-completions',
    baseUrl,
    input: option.images ? ['text', 'image'] : ['text'],
    reasoning: false,
    contextWindow: contextWindow ?? option.contextWindow,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

/** How every model's requests reach LiteLLM: its OpenAI-compatible chat completions API. */
export const LITELLM_STREAMS: ProviderStreams = { stream, streamSimple }

/**
 * Every offered model (`models.ts`), the default first; `model` is the default for new sessions. `streams` carries
 * the requests; only a test passes anything but LiteLLM's.
 */
export function makePiModels(
  env: ModelEnvironment,
  streams: ProviderStreams = LITELLM_STREAMS,
  contextWindow?: number,
  authorizeRoutine?: (runId: string) => Promise<void>,
  authorizeMember?: (session: string) => Promise<void>,
) {
  const options = modelOptions(env.MODELS, env.MODEL_ID)
  const [first, ...rest] = options
  const model = makePiModel(first, env.MODEL_BASE_URL, contextWindow)
  const others = rest.map((option) => makePiModel(option, env.MODEL_BASE_URL, contextWindow))
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
    api: streams,
  })
  const models = createModels()
  models.setProvider(provider)
  if (authorizeRoutine !== undefined || authorizeMember !== undefined) {
    const original = models.getModel.bind(models)
    models.getModel = (providerId, id) => {
      const runId = /^purrable-routine:(rr_[\w-]{1,100})$/u.exec(providerId)?.[1]
      const memberSession = /^purrable-member:(\d{1,12})$/u.exec(providerId)?.[1]
      const authorize =
        runId !== undefined && authorizeRoutine !== undefined
          ? () => authorizeRoutine(runId)
          : memberSession !== undefined && authorizeMember !== undefined
            ? () => authorizeMember(memberSession)
            : undefined
      if (authorize !== undefined && models.getProvider(providerId) === undefined) {
        models.setProvider(
          createProvider({
            id: providerId,
            name: 'Purrable scoped execution',
            baseUrl: env.MODEL_BASE_URL,
            models: options.map((option) => makePiModel(option, env.MODEL_BASE_URL, contextWindow, providerId)),
            auth: {
              apiKey: {
                name: 'Scoped model authority',
                resolve: async () => {
                  await authorize()
                  return { auth: { apiKey: env.MODEL_KEY } }
                },
              },
            },
            api: streams,
          }),
        )
      }
      return original(providerId, id)
    }
  }
  return { models, model, options }
}
