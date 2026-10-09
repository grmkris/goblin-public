import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { getCurrentSystemPrompt } from '@earendil-works/pi-ai/utils/transcript'
import type { AssistantMessage, Message, Model, ProviderStreams, ToolCall } from '@earendil-works/pi-ai'
import { isContextBlock } from '../../src/pi/context-tail.ts'

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
export type SeenRequest = {
  readonly messages: readonly SeenMessage[]
  readonly systemPrompt: string
  readonly tools: readonly string[]
  /** The trailing `<goblin-context>` block, kept apart from the messages (`pi/context-tail.ts`). */
  readonly context?: string
}

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
export function reply(messages: readonly Message[]): AssistantMessage['content'] {
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
    // The context block ends each request but is not a turn: the script answers, and records, the turns before it.
    const goblinContext = context.messages.find(isContextBlock)
    const messages = context.messages.filter((message) => !isContextBlock(message))
    seen({
      messages: messages.map((message) => ({
        role: message.role,
        // Pi's named sections are part of the actual prompt, even when system.content is empty.
        text: [textOf(message), ...(message.role === 'system' ? Object.values(message.sections ?? {}) : [])]
          .filter((part) => part !== null)
          .join('\n'),
      })),
      systemPrompt: getCurrentSystemPrompt(messages),
      tools: offeredTools(messages),
      ...(goblinContext === undefined ? {} : { context: textOf(goblinContext) }),
    })
    const content = respond(messages)
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
    const wait = delay(messages)
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
