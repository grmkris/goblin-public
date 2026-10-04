import type { Conversation, EntryRecord } from '@earendil-works/pi-durable'
import { authorOf } from '@purrable/contracts'
import { Predicate } from 'effect'
import { BACKGROUND } from './context.ts'

/** A user or assistant message; `author` names who wrote a user message when it was not the owner's browser. */
export type TranscriptMessage = {
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly author?: string
}

const textBlocks = (content: unknown): string[] => {
  if (Predicate.isString(content)) return [content]
  if (!Array.isArray(content)) return []
  return content.flatMap((block: unknown) =>
    Predicate.isObject(block) &&
    'type' in block &&
    block.type === 'text' &&
    'text' in block &&
    Predicate.isString(block.text) &&
    block.text !== ''
      ? [block.text]
      : [],
  )
}

/** One model message as transcript text; an author tag block on a user message becomes `author`. */
function transcriptMessage(role: 'user' | 'assistant', content: unknown): TranscriptMessage | undefined {
  const blocks = textBlocks(content)
  const author = role === 'user' && blocks.length > 1 ? authorOf(blocks[0] ?? '') : undefined
  const text = (author === undefined ? blocks : blocks.slice(1)).join('\n')
  if (text === '') return undefined
  return author === undefined ? { role, text } : { role, text, author }
}

/** The user and assistant text of Pi entries (oldest first), newest last. Tool traffic and system entries are left out. */
export const transcriptMessages = (entries: readonly EntryRecord[], limit: number): readonly TranscriptMessage[] =>
  entries
    .filter((entry) => entry.kind === 'pi.user' || entry.kind === 'pi.assistant')
    .flatMap((entry) => entry.model ?? [])
    .flatMap((message) =>
      message.role === 'user' || message.role === 'assistant'
        ? (transcriptMessage(message.role, message.content) ?? [])
        : [],
    )
    .slice(-limit)

const PAGE = 50
const MAX_PAGES = 10

/**
 * The last `limit` messages of a conversation from its whole history, not only what the model sees now (a reset or a
 * memory view hides older entries from the model, not from the people in the conversation).
 */
export async function recentMessages(conversation: Conversation, limit: number): Promise<readonly TranscriptMessage[]> {
  const newestFirst: EntryRecord[] = []
  let cursor: Parameters<Conversation['entries']>[2]
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await conversation.entries({}, PAGE, cursor, BACKGROUND)
    newestFirst.push(...batch.items)
    if (transcriptMessages(newestFirst, limit).length >= limit || batch.next === undefined) break
    cursor = batch.next
  }
  return transcriptMessages(newestFirst.toReversed(), limit)
}
