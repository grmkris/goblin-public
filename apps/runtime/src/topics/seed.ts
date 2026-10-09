import type { Conversation, EntryRecord } from '@earendil-works/pi-durable'
import type { SourceReference, TopicSeedData } from '@goblin/contracts'
import { BACKGROUND } from '../pi/context.ts'
import { transcriptMessages } from '../pi/transcript.ts'

/** The longest frozen excerpt (`SourceReference`), and how many of the chat's newest entries are searched for it. */
const EXCERPT = 1200
const NEWEST = 20

/**
 * The frozen excerpt a Topic made from a discussion keeps of it (ADR 0032): the calling chat's latest user message
 * (the owner's, or another author's it names), as the range from that entry through the chat's newest one, its text
 * cut to 1,200 characters. None when no user message is among `newestFirst`.
 */
export function latestOwnerExcerpt(chat: string, newestFirst: readonly EntryRecord[]): SourceReference | undefined {
  const newest = newestFirst[0]
  for (const entry of newestFirst) {
    const [message] = entry.kind === 'pi.user' ? transcriptMessages([entry], 1) : []
    if (message === undefined || newest === undefined) continue
    const text = message.author === undefined ? message.text : `${message.author}: ${message.text}`
    return { chat, entryStart: Number(entry.id), entryEnd: Number(newest.id), excerpt: text.slice(0, EXCERPT) }
  }
  return undefined
}

/**
 * The seed of a Topic the agent makes from the discussion in `chat` (whose Pi conversation is `conversation`): the
 * brief it wrote, and the frozen excerpt of the owner's latest message there. None when there is neither.
 */
export async function discussionSeed(
  conversation: Pick<Conversation, 'entries'>,
  chat: string,
  brief: string | undefined,
): Promise<TopicSeedData | undefined> {
  const newestFirst = (await conversation.entries({}, NEWEST, undefined, BACKGROUND)).items
  const source = latestOwnerExcerpt(chat, newestFirst)
  if (source === undefined && (brief === undefined || brief === '')) return undefined
  return { brief: brief ?? '', sources: source === undefined ? [] : [source] }
}
