// What the owner just sent, shown at once. The stream confirms a message when the server has committed it, which is
// quick, but a send over a slow link or to a busy agent would otherwise show nothing until then. The echo is dropped for
// the server's own entry when that arrives, and the entry takes the echo's React key, so the row never remounts.
import type { ChatMessage } from './chat-messages.ts'
import type { ConversationProjection } from './projection.ts'

/** A message sent and not yet read back: its own id (the row's React key), its words, and the newest entry before it. */
export type Echo = { readonly id: string; readonly text: string; readonly after: number }

/** The entry number a message's id starts with (`"12:0"` is entry 12). */
const entryOf = (id: string): number => Number.parseInt(id, 10)

/** The newest entry the projection holds; what a message sent now comes after. */
export function newestEntry(projection: ConversationProjection): number {
  return projection.entries.reduce(
    (newest, entry) => (typeof entry.id === 'number' ? Math.max(newest, entry.id) : newest),
    0,
  )
}

/**
 * Whether a message sent now starts a turn on its own. While a turn runs, or other messages wait, a send is queued and
 * shows in the queue until its turn comes; echoing it in the transcript would put it out of order.
 */
export const startsTurn = (projection: ConversationProjection): boolean =>
  !projection.running && projection.inbox.length === 0

/** The owner's message the stream has delivered for `echo`: the first of theirs after the entry it was sent behind. */
export function delivered(echo: Echo, messages: readonly ChatMessage[]): ChatMessage | undefined {
  return messages.find(
    (message) => message.role === 'user' && message.author === undefined && entryOf(message.id) > echo.after,
  )
}
