import type { Conversation, EntryRecord } from '@earendil-works/pi-durable'
import type { Attention } from '@goblin/contracts'
import { openAsks } from './attention.ts'
import { BACKGROUND, entryId } from './pi/context.ts'
import { type ReplyStats, replyStats } from './pi/transcript.ts'

/** Entries read per page, and pages at most, when a thread's newer entries are counted. */
const PAGE = 50
const MAX_PAGES = 20

/** The one read the ledger needs of a conversation. */
type Entries = Pick<Conversation, 'entries'>

/** What a chat's own entries say: its messages, and what in them still waits on the owner (A5, ADR 0032). */
export type ChatActivity = ReplyStats & { readonly asks: readonly Attention[] }

/** A thread's count so far, through its entry `through`. */
type Tally = ChatActivity & { readonly through: number }

/**
 * Counts each thread's own messages for the thread list, from Pi itself, so the count follows replays and needs no
 * table. It remembers each thread's count for as long as the agent is awake and reads only the entries written since,
 * so a quiet thread costs one empty read. Entry ids grow across every conversation, and a thread's own entries all
 * come after the entry it branched at (`floor`), so nothing it inherited from main is counted.
 */
export class ReplyLedger {
  readonly #tallies = new Map<string, Tally>()

  async stats(session: string, conversation: Entries, floor: number): Promise<ChatActivity> {
    const known = this.#tallies.get(session)
    const fresh = await newerEntries(conversation, known?.through ?? floor)
    if (fresh.length > 0) {
      const mine = fresh
        .filter((entry) => String(entry.conversationId) === session)
        .toSorted((a, b) => Number(a.id) - Number(b.id))
      const own = replyStats(mine)
      const lastReplyAt = own.lastReplyAt ?? known?.lastReplyAt
      this.#tallies.set(session, {
        through: Math.max(...fresh.map((entry) => Number(entry.id))),
        replies: (known?.replies ?? 0) + own.replies,
        asks: openAsks(mine, known?.asks),
        ...(lastReplyAt === undefined ? {} : { lastReplyAt }),
      })
    }
    const tally = this.#tallies.get(session)
    const asks = tally?.asks ?? []
    return tally?.lastReplyAt === undefined
      ? { replies: tally?.replies ?? 0, asks }
      : { replies: tally.replies, lastReplyAt: tally.lastReplyAt, asks }
  }
}

/** The conversation's entries after `after`, newest first, up to `MAX_PAGES` pages. */
async function newerEntries(conversation: Entries, after: number): Promise<readonly EntryRecord[]> {
  const entries: EntryRecord[] = []
  let cursor: Parameters<Conversation['entries']>[2]
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await conversation.entries({ minEntryId: entryId(after + 1) }, PAGE, cursor, BACKGROUND)
    entries.push(...batch.items)
    if (batch.next === undefined) break
    cursor = batch.next
  }
  return entries
}
