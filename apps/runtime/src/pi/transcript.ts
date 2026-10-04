import type { EntryRecord } from '@earendil-works/pi-durable'
import { Predicate } from 'effect'

export type TranscriptMessage = { readonly role: 'user' | 'assistant'; readonly text: string }

const blockText = (content: unknown): string => {
  if (Predicate.isString(content)) return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: unknown) =>
      Predicate.isObject(block) &&
      'type' in block &&
      block.type === 'text' &&
      'text' in block &&
      Predicate.isString(block.text)
        ? block.text
        : '',
    )
    .filter((text) => text !== '')
    .join('\n')
}

/** The user and assistant text of a Pi transcript, newest last. Tool traffic and system entries are left out. */
export const transcriptMessages = (entries: readonly EntryRecord[], limit: number): readonly TranscriptMessage[] => {
  const messages: TranscriptMessage[] = []
  for (const entry of entries) {
    if (entry.kind !== 'pi.user' && entry.kind !== 'pi.assistant') continue
    for (const message of entry.model ?? []) {
      if (message.role !== 'user' && message.role !== 'assistant') continue
      const text = blockText(message.content)
      if (text !== '') messages.push({ role: message.role, text })
    }
  }
  return messages.slice(-limit)
}
