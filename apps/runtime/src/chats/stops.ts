import { sql } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { attempt, attemptSync } from '../http/errors.ts'
import { BACKGROUND, conversationId } from '../pi/context.ts'
import type { PiSessions } from '../pi/sessions.ts'
import { dropRelaysTo } from '../pi/subagent-relay.ts'
import { type ChatDb, chatRow, chatSession } from './directory.ts'
import { fromPi } from './operations.ts'

// Close and Stop over the chat tree (ADRs 0017, 0018): which chats a Close reaches, which subagents a Stop reaches, as
// functions of the agent's database, and stopping their Pi work. Chats resolve to their current Pi sessions through
// the directory.

/**
 * `tree`: `id` and every conversation under it, as a recursive CTE. `UNION` drops repeats, so even a cycle in stored
 * parents would end.
 */
const tree = (id: string) =>
  sql`WITH RECURSIVE tree(id) AS (
        SELECT ${id}
        UNION
        SELECT conversation.session_id FROM app_conversations AS conversation
        JOIN tree ON conversation.parent_session = tree.id
      )`

/** `id` and every conversation under it, any depth, closed ones included. */
export const subtreeOf = (db: ChatDb, id: string): readonly string[] =>
  db.all<{ id: string }>(sql`${tree(id)} SELECT id FROM tree`).map((row) => row.id)

/** Stamps `id` and every open conversation under it closed, in one statement; returns what it closed. */
export const closeTree = (db: ChatDb, id: string, by: 'owner' | 'done', now: number): readonly string[] =>
  db
    .all<{ session_id: string }>(
      sql`${tree(id)}
          UPDATE app_conversations SET closed_at = ${now}, closed_by = ${by}
          WHERE closed_at IS NULL AND session_id IN tree
          RETURNING session_id`,
    )
    .map((row) => row.session_id)

/** Every open subagent below `id`, through subagents of subagents; threads branched from it are not included. */
export const subagentsBelow = (db: ChatDb, id: string): readonly string[] =>
  db
    .all<{ session_id: string }>(
      sql`WITH RECURSIVE tree(id) AS (
            SELECT ${id}
            UNION
            SELECT conversation.session_id FROM app_conversations AS conversation
            JOIN tree ON conversation.parent_session = tree.id
            WHERE conversation.kind = 'subagent' AND conversation.closed_at IS NULL
          )
          SELECT id AS session_id FROM tree WHERE id <> ${id}`,
    )
    .map((row) => row.session_id)

/** What stopping chats works with: the chat rows and Pi. */
type Stopping = { readonly db: ChatDb; readonly pi: PiSessions['Service'] }

/** Stops the relays carrying messages to each subagent among `chats` from its spawner. */
export const dropRelays = Effect.fn('Conversations.dropRelays')(function* (
  { db, pi }: Stopping,
  chats: readonly string[],
) {
  const harness = yield* fromPi(pi.pi)
  for (const chat of chats) {
    const row = chatRow(db, chat)
    if (row?.kind !== 'subagent' || row.parentSession === null) continue
    const parent = row.parentSession
    const { spawner, subagent } = yield* attemptSync(() => ({
      spawner: row.spawnerSession ?? chatSession(db, parent),
      subagent: chatSession(db, chat),
    }))
    yield* attempt(() => dropRelaysTo(harness, conversationId(spawner), conversationId(subagent)))
  }
})

/** Aborts each chat across background boundaries: its runs, its queued inputs and its background tasks. */
export const stopChats = Effect.fn('Conversations.stopChats')(function* (
  { db, pi }: Stopping,
  chats: readonly string[],
) {
  for (const chat of chats) {
    const found = yield* fromPi(pi.conversation(yield* attemptSync(() => chatSession(db, chat))))
    if (Option.isSome(found)) yield* attempt(() => found.value.abort(BACKGROUND, { background: true }))
  }
})
