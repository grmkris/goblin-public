import type { Message, ProviderStreams } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { isContextBlock } from '../../src/pi/context-tail.ts'
import { scriptedStreams } from './model.ts'

const textOf = (message: Message): string =>
  typeof message.content === 'string'
    ? message.content
    : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')

/** Controlled native model gates: release or cancellation ends them, without network or model spend. */
class QueueModel {
  readonly #held = new Map<string, () => void>()
  readonly #base = scriptedStreams()
  readonly streams: ProviderStreams = {
    stream: (target, context, options) => {
      const last = context.messages.findLast((message) => message.role === 'user' && !isContextBlock(message))
      const input = last === undefined ? '' : textOf(last)
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
      void this.#base
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
      return output
    },
    streamSimple: (target, context, options) => this.streams.stream(target, context, options),
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
