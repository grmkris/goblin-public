import type { Conversation, EntryRecord } from '@earendil-works/pi-durable'
import type { ThreadPreviewMessage } from '@purrable/contracts'
import { BACKGROUND, entryId } from './pi/context.ts'
import { transcriptMessages } from './pi/transcript.ts'

type Entries = Pick<Conversation, 'id' | 'entries'>
const PAGE = 40

/** Pi scans newest first. Find the first page by inclusive ID bounds, without reading later history in full. */
async function firstPage(conversation: Entries, after: number): Promise<readonly EntryRecord[]> {
  const read = (through?: number) =>
    conversation.entries(
      { minEntryId: entryId(after + 1), ...(through === undefined ? {} : { maxEntryId: entryId(through) }) },
      PAGE,
      undefined,
      BACKGROUND,
    )
  const newest = await read()
  if (newest.items.length < PAGE) return newest.items.toReversed()
  let low = after + 1
  let high = newest.items[0]?.id ?? low
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if ((await read(middle)).items.length >= PAGE) high = middle
    else low = middle + 1
  }
  return (await read(low)).items.toReversed()
}

/** Thoughts and calls stay quiet; arguments and tool output never inflate a preview. */
function quietOf(entry: EntryRecord): string[] {
  return (entry.model ?? []).flatMap((message) => {
    if (message.role !== 'assistant') return []
    return message.content
      .flatMap((block) => {
        if (block.type === 'thinking') return [`Thought · ${block.thinking.slice(0, 140)}`]
        if (block.type === 'toolCall') return [`Tool · ${block.name}`]
        return []
      })
      .slice(0, 8)
  })
}

function previewMessage(entry: EntryRecord): ThreadPreviewMessage[] {
  const words = transcriptMessages([entry], 1)[0]
  const quiet = quietOf(entry)
  if (words !== undefined) return [{ ...words, text: words.text.slice(0, 800), quiet }]
  return entry.kind === 'pi.assistant' && quiet.length > 0 ? [{ role: 'assistant', text: '', quiet }] : []
}

/** First five messages of this conversation itself, independent of compaction and forked parent history. */
export async function firstThreadMessages(conversation: Entries, floor: number): Promise<ThreadPreviewMessage[]> {
  const messages: ThreadPreviewMessage[] = []
  let after = floor
  for (let pages = 0; pages < 16 && messages.length < 5; pages += 1) {
    const page = await firstPage(conversation, after)
    messages.push(
      ...page
        .filter((entry) => entry.conversationId === conversation.id)
        .flatMap(previewMessage)
        .slice(0, 5 - messages.length),
    )
    if (page.length < PAGE) break
    after = page.at(-1)?.id ?? after
  }
  return messages
}
