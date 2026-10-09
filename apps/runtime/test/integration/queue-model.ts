import type { AssistantMessage, Message, ProviderStreams } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { isContextBlock } from '../../src/pi/context-tail.ts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { type SeenRequest, reply as scripted, scriptedStreams } from './model.ts'

const textOf = (message: Message): string =>
  typeof message.content === 'string'
    ? message.content
    : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')

/** The prompt a Persona's fork is asked with (`pi/persona-turn.ts`): its name is who is answering. */
const PERSONA_PROMPT = /^Answer the owner's message above as @(.+)\.$/u

/**
 * A Persona's fork scripted to call the tool its owner message asks for: `persona-call <tool> <json>` anywhere above
 * the prompt, once; the tool's result is then its answer. Anything else is the echo every other request gets.
 */
function personaCall(messages: readonly Message[]): AssistantMessage['content'] | undefined {
  const last = messages.findLast((message) => message.role !== 'system')
  if (last === undefined) return undefined
  if (last.role === 'toolResult') return undefined
  if (!PERSONA_PROMPT.test(textOf(last).split('\n').at(-1) ?? '')) return undefined
  for (const message of messages) {
    const call = /persona-call (\w+) (\{.*\})/u.exec(message.role === 'user' ? textOf(message) : '')
    if (call !== null)
      return [
        {
          type: 'toolCall',
          id: `persona-call-${messages.length}`,
          name: call[1] ?? '',
          arguments: JSON.parse(call[2] ?? '{}'),
        },
      ]
  }
  return undefined
}

/** A rerank request of automatic retrieval (`retrieval/auto.ts`): the owner's message and the candidates, as JSON. */
const Rerank = Schema.fromJsonString(
  Schema.Struct({ message: Schema.String, candidates: Schema.Array(Schema.Unknown) }),
)

/** Automatic retrieval's rerank selects the first candidate when the owner's message says `pick-sources`, else none. */
function rerank(messages: readonly Message[]): AssistantMessage['content'] | undefined {
  const last = messages.at(-1)
  const asked = last === undefined ? undefined : Option.getOrUndefined(Schema.decodeUnknownOption(Rerank)(textOf(last)))
  if (asked === undefined) return undefined
  const pick = asked.message.includes('pick-sources') && asked.candidates.length > 0
  return [{ type: 'text', text: JSON.stringify(pick ? { ids: [1], none: false } : { ids: [], none: true }) }]
}

/** Controlled native model gates: release or cancellation ends them, without network or model spend. */
class QueueModel {
  readonly #held = new Map<string, () => void>()
  readonly #requests: SeenRequest[] = []
  readonly #base = scriptedStreams(
    (request) => void this.#requests.push(request),
    (messages) => personaCall(messages) ?? rerank(messages) ?? scripted(messages),
  )
  readonly streams: ProviderStreams = {
    stream: (target, context, options) => {
      const last = context.messages.findLast((message) => message.role === 'user' && !isContextBlock(message))
      const text = last === undefined ? '' : textOf(last)
      // A Persona's fork is held by the `queue-hold:` token in the owner message it answers, keyed with its name.
      const answering = PERSONA_PROMPT.exec(text.split('\n').at(-1) ?? '')?.[1]
      // The token is read from the newest ask only: older asks stay in the chat the fork reads.
      const ask = context.messages.findLast((message) => textOf(message).startsWith('[to @'))
      const token = answering === undefined || ask === undefined ? undefined : /queue-hold:\S+/u.exec(textOf(ask))?.[0]
      const input = token === undefined ? text : `${token}@${answering ?? ''}`
      if (!input.startsWith('queue-hold:')) return this.#base.stream(target, context, options)
      const key = input
      const gate = Promise.withResolvers<void>()
      const release = () => {
        this.#held.delete(key)
        gate.resolve()
      }
      this.#held.set(key, release)
      const output = createAssistantMessageEventStream()
      options?.signal?.addEventListener('abort', release, { once: true })
      if (options?.signal?.aborted) release()
      this.#base
        .stream(target, context, options)
        .result()
        .then(async (reply) => {
          await gate.promise
          options?.signal?.removeEventListener('abort', release)
          const message = options?.signal?.aborted ? { ...reply, content: [], stopReason: 'aborted' as const } : reply
          output.push({ type: 'start', partial: message })
          if (message.stopReason === 'aborted') output.push({ type: 'error', reason: 'aborted', error: message })
          else output.push({ type: 'done', reason: 'stop', message })
          output.end(message)
        })
        .catch((error: unknown) => {
          // expected: a scripted answer that throws fails the held turn as a model error instead of hanging it
          const failed: AssistantMessage = {
            role: 'assistant',
            api: target.api,
            provider: target.provider,
            model: target.id,
            content: [],
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'error',
            errorMessage: error instanceof Error ? error.message : String(error),
            timestamp: 0,
          }
          output.push({ type: 'error', reason: 'error', error: failed })
          output.end(failed)
        })
      return output
    },
    streamSimple: (target, context, options) => this.streams.stream(target, context, options),
  }
  /** Every request the scripted model received, oldest first. */
  requests(): readonly SeenRequest[] {
    return this.#requests
  }
  held(): readonly string[] {
    return [...this.#held.keys()]
  }
  release(input: string): boolean {
    const release = this.#held.get(input)
    release?.()
    return release !== undefined
  }
}

// PersonalAgent calls modelStreams from its constructor, before subclass fields exist.
const fixtures = new WeakMap<object, QueueModel>()
export function queueModel(owner: object): QueueModel {
  let fixture = fixtures.get(owner)
  if (fixture === undefined) {
    fixture = new QueueModel()
    fixtures.set(owner, fixture)
  }
  return fixture
}
