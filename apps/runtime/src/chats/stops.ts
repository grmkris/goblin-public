import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { eq, sql } from 'drizzle-orm'
import type { PiHarness } from 'agents/harness/pi'
import { BACKGROUND, conversationId } from '../pi/context.ts'
import { dropRelaysTo } from '../pi/subagent-relay.ts'
import { appConversations } from '../storage/schema.ts'
import type { ChatDirectory } from './directory.ts'

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

/**
 * Close and Stop over the chat tree (ADRs 0017, 0018): which chats a Close reaches, which subagents a Stop reaches,
 * and stopping their Pi work. Chats resolve to their current Pi sessions through the shared directory.
 */
export class ChatStops {
  readonly #db: DrizzleSqliteDODatabase
  readonly #harness: PiHarness
  readonly #chats: ChatDirectory

  constructor(db: DrizzleSqliteDODatabase, harness: PiHarness, chats: ChatDirectory) {
    this.#db = db
    this.#harness = harness
    this.#chats = chats
  }

  /** `id` and every conversation under it, any depth, closed ones included. */
  subtree(id: string): readonly string[] {
    return this.#db.all<{ id: string }>(sql`${tree(id)} SELECT id FROM tree`).map((row) => row.id)
  }

  /** Stamps `id` and every open conversation under it closed, in one statement; returns what it closed. */
  closeTree(id: string, by: 'owner' | 'done', now: number): readonly string[] {
    return this.#db
      .all<{ session_id: string }>(
        sql`${tree(id)}
            UPDATE app_conversations SET closed_at = ${now}, closed_by = ${by}
            WHERE closed_at IS NULL AND session_id IN tree
            RETURNING session_id`,
      )
      .map((row) => row.session_id)
  }

  /** Every open subagent below `id`, through subagents of subagents; threads branched from it are not included. */
  subagentsBelow(id: string): readonly string[] {
    return this.#db
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
  }

  /** Stops the relays carrying messages to each subagent among `chats` from its spawner. */
  async dropRelays(chats: readonly string[]): Promise<void> {
    const pi = await this.#harness.pi()
    for (const chat of chats) {
      const row = this.#db.select().from(appConversations).where(eq(appConversations.chatId, chat)).get()
      if (row?.kind === 'subagent' && row.parentSession !== null)
        await dropRelaysTo(
          pi,
          conversationId(row.spawnerSession ?? this.#chats.session(row.parentSession)),
          conversationId(this.#chats.session(chat)),
        )
    }
  }

  /** Aborts each chat across background boundaries: its runs, its queued inputs and its background tasks. */
  async stop(chats: readonly string[]): Promise<void> {
    const pi = await this.#harness.pi()
    for (const chat of chats)
      await (
        await pi.conversation(conversationId(this.#chats.session(chat)), BACKGROUND)
      )?.abort(BACKGROUND, { background: true })
  }
}
