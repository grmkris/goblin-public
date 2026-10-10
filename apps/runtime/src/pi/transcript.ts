import type { Conversation, EntryRecord } from '@earendil-works/pi-durable'
import { authorOf } from '@goblin/contracts'
import type { TranscriptMessage } from '@goblin/contracts/internal'
import { Predicate } from 'effect'
import { BACKGROUND } from './context.ts'

/** A user or assistant message, as the internal API answers main's newest ones (`recent`). */
export type { TranscriptMessage }

/** The non-empty text blocks of message content (a plain string is one block). */
export const textBlocks = (content: unknown): string[] => {
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

/** What a thread holds of its own: how many messages of the owner and the agent, and when the newest was written. */
export type ReplyStats = { readonly replies: number; readonly lastReplyAt?: number }

/**
 * The owner's and the agent's messages in `entries` (tool traffic, system entries and messages without text left
 * out), with the newest one's time in seconds.
 */
export function replyStats(entries: readonly EntryRecord[]): ReplyStats {
  const messages = entries
    .filter((entry) => entry.kind === 'pi.user' || entry.kind === 'pi.assistant')
    .flatMap((entry) => entry.model ?? [])
    .filter(
      (message) =>
        (message.role === 'user' || message.role === 'assistant') &&
        transcriptMessage(message.role, message.content) !== undefined,
    )
  const newest = Math.max(0, ...messages.map((message) => message.timestamp))
  return newest === 0
    ? { replies: messages.length }
    : { replies: messages.length, lastReplyAt: Math.floor(newest / 1000) }
}

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

/** Whether the newest turn of `entries` (oldest first) was cut off: its last answer stopped at the output limit. */
export function cutOff(entries: readonly EntryRecord[]): boolean {
  for (const entry of entries.toReversed()) {
    if (entry.kind === 'pi.user') return false
    for (const message of (entry.model ?? []).toReversed())
      if (message.role === 'assistant') return message.stopReason === 'length'
  }
  return false
}

/**
 * What the newest turn of `entries` (oldest first) asked the owner with `ask_user`, as the tool reported it; empty
 * when that turn asked nothing. A turn that ends in a question has no final text of its own.
 */
export function askedText(entries: readonly EntryRecord[]): string {
  for (const entry of entries.toReversed()) {
    if (entry.kind === 'pi.user') return ''
    for (const message of entry.model ?? [])
      if (message.role === 'toolResult' && message.toolName === 'ask_user')
        return textBlocks(message.content).join('\n')
  }
  return ''
}
