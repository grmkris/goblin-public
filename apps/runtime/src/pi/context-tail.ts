import type { Message, UserMessage } from '@earendil-works/pi-ai'

/** How goblin's context block opens: the trailing message that carries what changes between requests. */
export const CONTEXT_OPEN = '<goblin-context>'
const CONTEXT_CLOSE = '</goblin-context>'
const NOTE =
  'goblin wrote this block for this request only: the current state of your apps and skills. It is not from the owner.'

const textOf = (message: Message): string => {
  if (message.role !== 'user') return ''
  if (typeof message.content === 'string') return message.content
  return message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

/** Whether `message` is goblin's context block rather than something someone wrote. */
export const isContextBlock = (message: Message): boolean => textOf(message).startsWith(CONTEXT_OPEN)

/**
 * `messages` with `text` as the `<key>` part of the trailing context block, which is appended when there is none yet.
 * What changes between requests (the apps and their versions, the skills on offer) goes here rather than into the
 * system prompt: pi-ai folds every system-prompt change into the one leading system message, which empties the
 * provider's prompt cache, while a trailing block leaves everything before it cacheable. A `beforeRequest` hook
 * returns the result; it is for that request only and Pi stores none of it.
 */
export function withContext(messages: readonly Message[], key: string, text: string): readonly Message[] {
  const part = `<${key}>\n${text}\n</${key}>`
  const last = messages.at(-1)
  if (last !== undefined && isContextBlock(last)) {
    const body = textOf(last).slice(0, -CONTEXT_CLOSE.length).trimEnd()
    return [...messages.slice(0, -1), block(`${body}\n${part}\n${CONTEXT_CLOSE}`, last.timestamp)]
  }
  return [...messages, block(`${CONTEXT_OPEN}\n${NOTE}\n${part}\n${CONTEXT_CLOSE}`, last?.timestamp ?? 0)]
}

const block = (text: string, timestamp: number): UserMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
  timestamp,
})
