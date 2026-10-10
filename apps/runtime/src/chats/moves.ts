import type { MoveReceipt } from '@goblin/contracts'
import { and, between, eq, inArray, or, sql } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { Internal } from '../http/errors.ts'
import { registerChat } from './directory.ts'
import { appChatMoves, appConversations, appRegistry } from '../storage/schema.ts'

export type MoveRow = typeof appChatMoves.$inferSelect

/**
 * The states a move is still working through; a chat has at most one move in them (a partial unique index, which
 * also counts `swapped`).
 */
const ACTIVE_MOVE = ['requested', 'forked'] as const

/** Why a running turn's swap that never settled is refused (`retireSwaps`). */
const UNSUPPORTED = 'unsupported'

/**
 * What the owner and the web see of a move. Nothing starts a running turn's swap, but an agent that ran it may still
 * hold its rows: one that has not settled reads as refused, as `retireSwaps` leaves it.
 */
export const moveReceipt = (row: MoveRow): MoveReceipt => {
  const move = {
    operationId: row.operationId,
    chat: row.chatId,
    ...(row.threadChat === null ? {} : { thread: row.threadChat }),
  }
  if (row.state === 'swapped' || (row.mode === 'swap' && row.state !== 'settled' && row.state !== 'refused'))
    return { ...move, state: 'refused', reason: UNSUPPORTED }
  return { ...move, state: row.state, ...(row.reason === null ? {} : { reason: row.reason }) }
}

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
export function movedFrom(
  db: SQLiteAsyncDatabase<'sync', unknown>,
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

const decodeRelays = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Finite)))

// The application rows of moves to thread (ADR 0034), as functions of the agent's database: one per owner operation,
// through `requested → forked → settled` or `refused`. Each is a short synchronous SQLite step; Pi work happens
// between them.

/** The moves' database: the agent's SQLite, or a test's. */
type MoveDb = SQLiteAsyncDatabase<'sync', unknown>

/** The move `operation` names, if any. */
export const moveOf = (db: MoveDb, operation: string): MoveRow | undefined =>
  db.select().from(appChatMoves).where(eq(appChatMoves.operationId, operation)).get()

/** The move `operation` names; a missing one is `Internal`, since the mover wrote it. */
export const requireMove = (db: MoveDb, operation: string): MoveRow => {
  const row = moveOf(db, operation)
  if (row === undefined) throw new Internal({ reason: 'move_missing' })
  return row
}

/** The move a chat is working through, if any. */
export const activeMove = (db: MoveDb, chat: string): MoveRow | undefined =>
  db
    .select()
    .from(appChatMoves)
    .where(and(eq(appChatMoves.chatId, chat), inArray(appChatMoves.state, [...ACTIVE_MOVE])))
    .get()

/** Whether the turn `entry` started already moved out of `chat`. */
export const turnMoved = (db: MoveDb, chat: string, entry: number): boolean => {
  const row = db
    .select({ op: appChatMoves.operationId })
    .from(appChatMoves)
    .where(
      and(
        eq(appChatMoves.chatId, chat),
        eq(appChatMoves.messageEntry, entry),
        inArray(appChatMoves.state, ['forked', 'settled']),
      ),
    )
    .get()
  return row !== undefined
}

/** Moves a restart must finish: a settled turn's, never a swap's. */
export const unfinishedMoves = (db: MoveDb): readonly MoveRow[] =>
  db
    .select()
    .from(appChatMoves)
    .where(and(eq(appChatMoves.mode, 'settled'), inArray(appChatMoves.state, [...ACTIVE_MOVE])))
    .all()

/** Refuses every swap that has not settled, so it frees its chat; how many it refused. */
export const retireSwaps = (db: MoveDb, now: number): number => {
  const unfinished = or(
    eq(appChatMoves.state, 'swapped'),
    and(eq(appChatMoves.mode, 'swap'), inArray(appChatMoves.state, [...ACTIVE_MOVE])),
  )
  return db
    .update(appChatMoves)
    .set({ state: 'refused', reason: UNSUPPORTED, updatedAt: now })
    .where(unfinished)
    .returning({ operation: appChatMoves.operationId })
    .all().length
}

/** A move the preconditions refused, kept so the same operation answers the same. */
export const refuseMove = (
  db: MoveDb,
  input: { operation: string; chat: string; entry: number; reason: string; now: number },
): MoveRow => {
  db.insert(appChatMoves)
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
  return requireMove(db, input.operation)
}

/** The move begins: it holds the chat's one active move until it settles. */
export const beginMove = (
  db: MoveDb,
  input: { operation: string; chat: string; source: string; entry: number; end: number; now: number },
): MoveRow => {
  db.insert(appChatMoves)
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
  return requireMove(db, input.operation)
}

/** The Thread's Pi fork exists. */
export const forkedMove = (db: MoveDb, operation: string, fork: string, now: number): MoveRow => {
  db.update(appChatMoves)
    .set({ forkSession: fork, state: 'forked', updatedAt: now })
    .where(and(eq(appChatMoves.operationId, operation), eq(appChatMoves.state, 'requested')))
    .run()
  return requireMove(db, operation)
}

/**
 * The moved Thread's rows, in one transaction with what else belongs to it: the threads branched from the moved turn,
 * the helpers it started and its App placements.
 */
export const registerMovedThread = (db: MoveDb, row: MoveRow, thread: ThreadRow, now: number): void => {
  const source = row.sourceSession
  const fork = row.forkSession
  const end = row.cutEntry
  if (source === null || fork === null || end === null) throw new Internal({ reason: 'move_unforked' })
  const chat = row.chatId
  const turn = between(appConversations.forkEntry, row.messageEntry, end)
  db.transaction(() => {
    db.update(appConversations)
      .set({ parentSession: thread.chat })
      .where(and(eq(appConversations.parentSession, chat), eq(appConversations.kind, 'thread'), turn))
      .run()
    db.run(
      sql`UPDATE app_conversations SET parent_session = ${thread.chat}
          WHERE parent_session = ${chat} AND kind = 'subagent' AND spawner_session = ${source}
            AND CAST(session_id AS INTEGER) > ${row.messageEntry}`,
    )
    registerChat(db, {
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
    db.update(appRegistry)
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
    db.run(
      sql`INSERT OR IGNORE INTO app_skill_activations (session_id, server_id, uri, entry, activated_at)
          SELECT ${fork}, server_id, uri, entry, activated_at FROM app_skill_activations WHERE session_id = ${source}`,
    )
    db.update(appChatMoves)
      .set({ threadChat: thread.chat, updatedAt: now })
      .where(eq(appChatMoves.operationId, row.operationId))
      .run()
  })
}

/** The relays a move hands over to the Thread, once chosen; undefined before. */
export const movedRelays = (row: MoveRow): readonly number[] | undefined =>
  row.relays === null ? undefined : Option.getOrElse(decodeRelays(row.relays), () => [])

/** Persists the relays to hand over before any is touched, so a restarted move hands over the same ones. */
export const saveRelays = (
  db: MoveDb,
  operation: string,
  relays: readonly number[],
  now: number,
): readonly number[] => {
  db.update(appChatMoves)
    .set({ relays: JSON.stringify(relays), updatedAt: now })
    .where(eq(appChatMoves.operationId, operation))
    .run()
  return relays
}

/** The moved turn's helpers now relay through the Thread: their anchors stay, their relays and roster moved. */
export const respawnHelpers = (db: MoveDb, source: string, fork: string, helpers: readonly string[]): void => {
  if (helpers.length === 0) return
  db.update(appConversations)
    .set({ spawnerSession: fork })
    .where(and(eq(appConversations.spawnerSession, source), inArray(appConversations.chatId, [...helpers])))
    .run()
}

/** The move is done: its Thread holds the turn and its helpers. */
export const settleMove = (db: MoveDb, operation: string, now: number): void => {
  db.update(appChatMoves)
    .set({ state: 'settled', updatedAt: now })
    .where(and(eq(appChatMoves.operationId, operation), eq(appChatMoves.state, 'forked')))
    .run()
}

/** A move that cannot finish (its fork failed before it committed). */
export const abandonMove = (db: MoveDb, operation: string, reason: string, now: number): void => {
  db.update(appChatMoves)
    .set({ state: 'refused', reason, updatedAt: now })
    .where(eq(appChatMoves.operationId, operation))
    .run()
}
