import type { MoveReceipt } from '@goblin/contracts'
import { and, between, eq, inArray, sql } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { appChatMoves, appConversations, appRegistry } from '../storage/schema.ts'

export type MoveRow = typeof appChatMoves.$inferSelect

/** The states a move is still working through; a chat has at most one move in them (a partial unique index). */
const ACTIVE_MOVE = ['requested', 'forked', 'swapped'] as const

/** What the owner and the web see of a move. */
export const moveReceipt = (row: MoveRow): MoveReceipt => ({
  operationId: row.operationId,
  chat: row.chatId,
  ...(row.threadChat === null ? {} : { thread: row.threadChat }),
  mode: row.mode,
  state: row.state,
  ...(row.reason === null ? {} : { reason: row.reason }),
})

/** The moved Thread's row, made once the Thread's Pi fork exists (ADR 0034). */
export type ThreadRow = {
  readonly chat: string
  readonly title: string
  readonly topic: number
  /** The chat's entry just before the moved message: the Thread shows its replies from there. */
  readonly before: number | null
  readonly recallThrough: number | null
}

/** Where a moved Thread came from, for its view: the chat its turn left and the move's operation (ADR 0034). */
export function movedFrom<RunResult>(
  db: SQLiteAsyncDatabase<'sync', RunResult>,
  originOp: string | null,
): { readonly movedFrom?: { readonly chat: string; readonly operationId: string } } {
  if (originOp === null) return {}
  const move = db
    .select({ chat: appChatMoves.chatId })
    .from(appChatMoves)
    .where(eq(appChatMoves.operationId, originOp))
    .get()
  return move === undefined ? {} : { movedFrom: { chat: move.chat, operationId: originOp } }
}

const decodeRelays = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Number)))

/**
 * The application rows of moves to thread (ADR 0034): one per owner operation, through `requested → forked →
 * settled` or `refused`. Every method is a short synchronous SQLite step; Pi work happens between them.
 */
export class MoveStore<RunResult = unknown> {
  readonly #db: SQLiteAsyncDatabase<'sync', RunResult>

  constructor(db: SQLiteAsyncDatabase<'sync', RunResult>) {
    this.#db = db
  }

  get(operation: string): MoveRow | undefined {
    return this.#db.select().from(appChatMoves).where(eq(appChatMoves.operationId, operation)).get()
  }

  require(operation: string): MoveRow {
    const row = this.get(operation)
    if (row === undefined) throw new Error(`move ${operation} is missing`)
    return row
  }

  /** The move a chat is working through, if any. */
  active(chat: string): MoveRow | undefined {
    return this.#db
      .select()
      .from(appChatMoves)
      .where(and(eq(appChatMoves.chatId, chat), inArray(appChatMoves.state, [...ACTIVE_MOVE])))
      .get()
  }

  /** Whether the turn `entry` started already moved out of `chat`. */
  moved(chat: string, entry: number): boolean {
    const row = this.#db
      .select({ op: appChatMoves.operationId })
      .from(appChatMoves)
      .where(
        and(
          eq(appChatMoves.chatId, chat),
          eq(appChatMoves.messageEntry, entry),
          inArray(appChatMoves.state, ['forked', 'swapped', 'settled']),
        ),
      )
      .get()
    return row !== undefined
  }

  /** Moves a restart must finish. */
  unfinished(): readonly MoveRow[] {
    return this.#db
      .select()
      .from(appChatMoves)
      .where(inArray(appChatMoves.state, [...ACTIVE_MOVE]))
      .all()
  }

  /** A move the preconditions refused, kept so the same operation answers the same. */
  refuse(input: { operation: string; chat: string; entry: number; reason: string; now: number }): MoveRow {
    this.#db
      .insert(appChatMoves)
      .values({
        operationId: input.operation,
        chatId: input.chat,
        messageEntry: input.entry,
        mode: 'settled',
        state: 'refused',
        reason: input.reason,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing()
      .run()
    return this.require(input.operation)
  }

  /** The move begins: it holds the chat's one active move until it settles. */
  begin(input: { operation: string; chat: string; source: string; entry: number; end: number; now: number }): MoveRow {
    this.#db
      .insert(appChatMoves)
      .values({
        operationId: input.operation,
        chatId: input.chat,
        sourceSession: input.source,
        messageEntry: input.entry,
        cutEntry: input.end,
        mode: 'settled',
        state: 'requested',
        createdAt: input.now,
        updatedAt: input.now,
      })
      .run()
    return this.require(input.operation)
  }

  /** The Thread's Pi fork exists. */
  forked(operation: string, fork: string, now: number): MoveRow {
    this.#db
      .update(appChatMoves)
      .set({ forkSession: fork, state: 'forked', updatedAt: now })
      .where(and(eq(appChatMoves.operationId, operation), eq(appChatMoves.state, 'requested')))
      .run()
    return this.require(operation)
  }

  /**
   * The moved Thread's rows, in one transaction with what else belongs to it: the threads branched from the moved
   * turn, the helpers it started and its App placements.
   */
  register(row: MoveRow, thread: ThreadRow, now: number): void {
    const source = row.sourceSession
    const fork = row.forkSession
    const end = row.cutEntry
    if (source === null || fork === null || end === null) throw new Error(`move ${row.operationId} has no fork`)
    const chat = row.chatId
    const turn = between(appConversations.forkEntry, row.messageEntry, end)
    this.#db.transaction(() => {
      this.#db
        .update(appConversations)
        .set({ parentSession: thread.chat })
        .where(and(eq(appConversations.parentSession, chat), eq(appConversations.kind, 'thread'), turn))
        .run()
      this.#db.run(
        sql`UPDATE app_conversations SET parent_session = ${thread.chat}
            WHERE parent_session = ${chat} AND kind = 'subagent' AND spawner_session = ${source}
              AND CAST(session_id AS INTEGER) > ${row.messageEntry}`,
      )
      this.#db
        .insert(appConversations)
        .values({
          chatId: thread.chat,
          piSession: fork,
          kind: 'thread',
          title: thread.title,
          parentSession: chat,
          forkEntry: thread.before,
          recallThrough: thread.recallThrough,
          topicId: thread.topic,
          originOp: row.operationId,
          createdAt: now,
        })
        .run()
      this.#db
        .update(appRegistry)
        .set({ chatId: thread.chat })
        .where(
          and(
            eq(appRegistry.chatId, chat),
            eq(appRegistry.sessionId, source),
            between(appRegistry.entryId, row.messageEntry, end),
          ),
        )
        .run()
      // Skills the moved turn loaded stay loaded in the Thread, whose context holds them.
      this.#db.run(
        sql`INSERT OR IGNORE INTO app_skill_activations (session_id, server_id, uri, entry, activated_at)
            SELECT ${fork}, server_id, uri, entry, activated_at FROM app_skill_activations WHERE session_id = ${source}`,
      )
      this.#db
        .update(appChatMoves)
        .set({ threadChat: thread.chat, updatedAt: now })
        .where(eq(appChatMoves.operationId, row.operationId))
        .run()
    })
  }

  /** The relays a move hands over to the Thread, once chosen; undefined before. */
  relaysOf(row: MoveRow): readonly number[] | undefined {
    return row.relays === null ? undefined : Option.getOrElse(decodeRelays(row.relays), () => [])
  }

  /** Persists the relays to hand over before any is touched, so a restarted move hands over the same ones. */
  saveRelays(operation: string, relays: readonly number[], now: number): readonly number[] {
    this.#db
      .update(appChatMoves)
      .set({ relays: JSON.stringify(relays), updatedAt: now })
      .where(eq(appChatMoves.operationId, operation))
      .run()
    return relays
  }

  /** The moved turn's helpers now relay through the Thread: their anchors stay, their relays and roster moved. */
  respawn(source: string, fork: string, helpers: readonly string[]): void {
    if (helpers.length === 0) return
    this.#db
      .update(appConversations)
      .set({ spawnerSession: fork })
      .where(and(eq(appConversations.spawnerSession, source), inArray(appConversations.chatId, [...helpers])))
      .run()
  }

  settled(operation: string, now: number): void {
    this.#db
      .update(appChatMoves)
      .set({ state: 'settled', updatedAt: now })
      .where(and(eq(appChatMoves.operationId, operation), eq(appChatMoves.state, 'forked')))
      .run()
  }

  /** A move that cannot finish (its fork failed before it committed). */
  abandon(operation: string, reason: string, now: number): void {
    this.#db
      .update(appChatMoves)
      .set({ state: 'refused', reason, updatedAt: now })
      .where(eq(appChatMoves.operationId, operation))
      .run()
  }
}
