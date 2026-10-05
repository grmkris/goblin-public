import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import type { AssistantMessage, Message, Model, ProviderStreams, ToolCall } from '@earendil-works/pi-ai'

export const FIXTURE_INPUT = 'persist this lifecycle fixture input'
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

/** One message of a request the scripted model received, as role and plain text. */
export type SeenMessage = { readonly role: string; readonly text: string }
/** A request the scripted model received: its messages and the names of the tools it was offered. */
export type SeenRequest = { readonly messages: readonly SeenMessage[]; readonly tools: readonly string[] }

const textOf = (message: Message): string =>
  typeof message.content === 'string'
    ? message.content
    : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')

/** The tools a request offers: system messages add and remove them as the transcript goes. */
function offeredTools(messages: readonly Message[]): string[] {
  const tools = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'system') continue
    for (const tool of message.toolsAdded ?? []) tools.add(tool.name)
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name)
  }
  return [...tools]
}

/**
 * What the scripted model answers, from the newest turn: after a tool round, `done`; to `call <tool> <json>`, that
 * tool call; to anything else, `echo: <text>`. Deterministic, keyless, no network.
 */
function reply(messages: readonly Message[]): AssistantMessage['content'] {
  // Pi appends a changed system prompt after the newest turn, so the turn to answer is the last non-system message.
  const last = messages.findLast((message) => message.role !== 'system')
  if (last?.role === 'toolResult') return [{ type: 'text', text: `done: ${textOf(last)}` }]
  const text = last === undefined ? '' : (textOf(last).split('\n').at(-1) ?? '')
  const call = /^call (\w+) (\{.*\})$/u.exec(text)
  if (call === null) return [{ type: 'text', text: `echo: ${text}` }]
  const tool: ToolCall = {
    type: 'toolCall',
    id: `call-${messages.length}`,
    name: call[1] ?? '',
    arguments: JSON.parse(call[2] ?? '{}'),
  }
  return [tool]
}

/** The scripted model's transport; `seen` receives every request's messages and `respond` chooses its answer. */
export function scriptedStreams(
  seen: (request: SeenRequest) => void = () => undefined,
  respond: (messages: readonly Message[]) => AssistantMessage['content'] = reply,
  delay: (messages: readonly Message[]) => number = () => 0,
): ProviderStreams {
  const stream: ProviderStreams['stream'] = (target, context) => {
    seen({
      messages: context.messages.map((message) => ({
        role: message.role,
        // Pi's named sections are part of the actual prompt, even when system.content is empty.
        text: [textOf(message), ...(message.role === 'system' ? Object.values(message.sections ?? {}) : [])]
          .filter((part) => part !== null)
          .join('\n'),
      })),
      tools: offeredTools(context.messages),
    })
    const content = respond(context.messages)
    const message: AssistantMessage = {
      role: 'assistant',
      api: target.api,
      provider: target.provider,
      model: target.id,
      content,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop',
      timestamp: 0,
    }
    const output = createAssistantMessageEventStream()
    const publish = () => {
      output.push({ type: 'start', partial: message })
      output.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message })
      output.end(message)
    }
    const wait = delay(context.messages)
    if (wait > 0) setTimeout(publish, wait)
    else queueMicrotask(publish)
    return output
  }
  return { stream, streamSimple: stream }
}

export function fixtureModels() {
  const models = createModels()
  models.setProvider(
    createProvider({
      id: model.provider,
      models: [model],
      auth: { apiKey: { name: 'keyless fixture', resolve: async () => ({ auth: {} }) } },
      api: scriptedStreams(),
    }),
  )
  return models
}
