import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { stream, streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import { clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import type { AssistantMessage, Model, ProviderStreams } from '@earendil-works/pi-ai'
import type { ModelOption } from '@goblin/contracts'
import type { RuntimeEnv } from '../env.ts'
import { modelOptions } from '../models.ts'

type ModelEnvironment = Pick<RuntimeEnv, 'MODEL_ID' | 'MODEL_BASE_URL' | 'MODEL_KEY'> &
  Partial<Pick<RuntimeEnv, 'MODELS'>>

/** Every model is served by the deployment's LiteLLM under one provider id; `session.setModel` names it. */
export const MODEL_PROVIDER = 'goblin-litellm'

/**
 * The most a model writes in one response. pi-ai sends it on every request (clamped to what the context leaves), and
 * reasoning models spend part of it thinking, so it is generous: at 8,192 glm-5.3 and qwen3.8-max ran out mid-answer.
 * A response cut here ends with `stopReason: 'length'`, which the owner sees.
 */
export const MAX_OUTPUT_TOKENS = 32_768

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
    maxTokens: MAX_OUTPUT_TOKENS,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

/**
 * The least room an answer is sent with. pi-ai clamps the output limit to what the context leaves, down to one token,
 * and a reasoning model spends a small limit thinking: glm-5.3 on a full Personal chat answered one token, cut off,
 * which Pi does not take for a full context. Below this the request is not sent: it fails as a context overflow, so
 * Pi compacts the conversation and tries once more.
 */
export const MIN_ANSWER_ROOM = 4096

/** A response that never reached the provider: the context leaves too little room for an answer. */
function tooFull(model: Model<'openai-completions'>, room: number) {
  const events = createAssistantMessageEventStream()
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const message: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
    stopReason: 'error',
    // Worded to match pi-ai's overflow patterns ("exceeds the context window"), which start Pi's compaction.
    errorMessage: `The conversation exceeds the context window: ${String(room)} tokens left for the answer.`,
    timestamp: Date.now(),
  }
  events.push({ type: 'error', reason: 'error', error: message })
  events.end()
  return events
}

/** How every model's requests reach LiteLLM: its OpenAI-compatible chat completions API, never with a starved answer. */
export const LITELLM_STREAMS: ProviderStreams = {
  stream,
  streamSimple: (model, context, options) => {
    const wanted = options?.maxTokens ?? model.maxTokens
    const room = clampMaxTokensToContext(model, context, wanted)
    // SAFETY: goblin's provider serves only openai-completions models (makePiModel).
    const target = model as Model<'openai-completions'>
    return room < Math.min(MIN_ANSWER_ROOM, wanted) ? tooFull(target, room) : streamSimple(target, context, options)
  },
}

/**
 * Every offered model (`models.ts`), the default first; `model` is the default for new sessions. `streams` carries
 * the requests; only a test passes anything but LiteLLM's.
 */
export function makePiModels(
  env: ModelEnvironment,
  streams: ProviderStreams = LITELLM_STREAMS,
  contextWindow?: number,
  authorizeRoutine?: (runId: string) => Promise<void>,
) {
  const options = modelOptions(env.MODELS, env.MODEL_ID)
  const [first, ...rest] = options
  const model = makePiModel(first, env.MODEL_BASE_URL, contextWindow)
  const others = rest.map((option) => makePiModel(option, env.MODEL_BASE_URL, contextWindow))
  const provider = createProvider({
    id: MODEL_PROVIDER,
    name: 'goblin LiteLLM',
    baseUrl: env.MODEL_BASE_URL,
    models: [model, ...others],
    auth: {
      apiKey: {
        name: 'goblin model key',
        resolve: async () => ({ auth: { apiKey: env.MODEL_KEY } }),
      },
    },
    api: streams,
  })
  const models = createModels()
  models.setProvider(provider)
  if (authorizeRoutine !== undefined) {
    const original = models.getModel.bind(models)
    models.getModel = (providerId, id) => {
      const runId = /^goblin-routine:(rr_[\w-]{1,100})$/u.exec(providerId)?.[1]
      if (runId !== undefined && models.getProvider(providerId) === undefined) {
        models.setProvider(
          createProvider({
            id: providerId,
            name: 'goblin routine',
            baseUrl: env.MODEL_BASE_URL,
            models: options.map((option) => makePiModel(option, env.MODEL_BASE_URL, contextWindow, providerId)),
            auth: {
              apiKey: {
                name: 'Routine model authority',
                resolve: async () => {
                  await authorizeRoutine(runId)
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
