import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import type { AssistantMessage, Model } from '@earendil-works/pi-ai'

export const FIXTURE_INPUT = 'persist this lifecycle fixture input'
export const FIXTURE_ANSWER = 'fixture-persisted-answer'
export const model: Model<'openai-completions'> = {
  id: 'lifecycle-fixture',
  name: 'Lifecycle fixture',
  provider: 'fixture',
  api: 'openai-completions',
  baseUrl: 'https://no-model-calls.invalid',
  reasoning: false,
  input: ['text'],
  contextWindow: 8192,
  maxTokens: 256,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

/** Deterministic provider only for native lifecycle tests; no network or credentials. */
function stream() {
  const output = createAssistantMessageEventStream()
  const message: AssistantMessage = {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: 'text', text: FIXTURE_ANSWER }],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 0,
  }
  queueMicrotask(() => {
    output.push({ type: 'start', partial: message })
    output.push({ type: 'done', reason: 'stop', message })
    output.end(message)
  })
  return output
}

export function fixtureModels() {
  const models = createModels()
  models.setProvider(
    createProvider({
      id: model.provider,
      models: [model],
      auth: { apiKey: { name: 'keyless fixture', resolve: async () => ({ auth: {} }) } },
      api: { stream, streamSimple: stream },
    }),
  )
  return models
}
