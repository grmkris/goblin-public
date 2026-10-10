import { and, count, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import { appChatMemoryLog, appChatMemoryNodes, appChatMemoryState } from '../storage/chat-memory.ts'
import { appConversations } from '../storage/schema.ts'
import type { LogKind } from './log.ts'
import { type Node, nodeKey } from './tree.ts'

/** The memory tables' database: the agent's SQLite (or a test's). */
export type MemoryDb = SQLiteAsyncDatabase<'sync', unknown>

// Each Topic Conversation's memory as stored (ADR 0032), as functions of the agent's database: the messages it
// remembers in order, the summary tree over them and its state, every row keyed by the chat id.

/** Messages `chat`'s memory holds. */
export const rememberedCount = (db: MemoryDb, chat: string): number =>
  db.select({ n: count() }).from(appChatMemoryLog).where(eq(appChatMemoryLog.chatId, chat)).get()?.n ?? 0

/** Messages `chat`'s memory holds up to and including its entry `entry`: what a thread branched there may zoom into. */
export const rememberedThrough = (db: MemoryDb, chat: string, entry: number): number =>
  db
    .select({ n: count() })
    .from(appChatMemoryLog)
    .where(and(eq(appChatMemoryLog.chatId, chat), lte(appChatMemoryLog.entryId, entry)))
    .get()?.n ?? 0

/** `chat`'s memory state: its newest entry when it began and how far its newest view reaches; none before it began. */
export const memoryState = (db: MemoryDb, chat: string) =>
  db.select().from(appChatMemoryState).where(eq(appChatMemoryState.chatId, chat)).get()

/** How far `chat`'s newest view reaches, in messages (0 before its first). */
export const viewReach = (db: MemoryDb, chat: string): number => memoryState(db, chat)?.viewThrough ?? 0

/** The view of `chat` through message `through` is in its Conversation: the next one must reach further. */
export const recordView = (db: MemoryDb, chat: string, through: number): void => {
  db.update(appChatMemoryState).set({ viewThrough: through }).where(eq(appChatMemoryState.chatId, chat)).run()
}

/** `chat`'s memory begins after its entry `originEntry`, once: a memory that began already keeps its state. */
export const beginMemory = (db: MemoryDb, chat: string, originEntry: number): void => {
  db.insert(appChatMemoryState).values({ chatId: chat, originEntry, viewThrough: 0 }).onConflictDoNothing().run()
}

/**
 * Forgets `chat`'s messages from `size` on, with every summary that covers one, and pulls its view back to `size` at
 * most, in one transaction: a moved turn (Move to thread) leaves the memory of the chat it left.
 */
export const forgetFrom = (db: MemoryDb, chat: string, size: number): void => {
  db.transaction((tx) => {
    tx.delete(appChatMemoryLog)
      .where(and(eq(appChatMemoryLog.chatId, chat), gte(appChatMemoryLog.idx, size)))
      .run()
    tx.delete(appChatMemoryNodes)
      .where(
        and(
          eq(appChatMemoryNodes.chatId, chat),
          sql`(${appChatMemoryNodes.idx} + 1) * (1 << ${appChatMemoryNodes.level}) > ${size}`,
        ),
      )
      .run()
    tx.update(appChatMemoryState)
      .set({ viewThrough: sql`min(${appChatMemoryState.viewThrough}, ${size})` })
      .where(eq(appChatMemoryState.chatId, chat))
      .run()
  })
}

/** `chat`'s message `idx` as remembered: its Pi entry and kind; none when it is not remembered. */
export const loggedAt = (db: MemoryDb, chat: string, idx: number) =>
  db
    .select()
    .from(appChatMemoryLog)
    .where(and(eq(appChatMemoryLog.chatId, chat), eq(appChatMemoryLog.idx, idx)))
    .get()

/** `chat`'s newest remembered message, if any. */
export const lastLogged = (db: MemoryDb, chat: string) =>
  db
    .select()
    .from(appChatMemoryLog)
    .where(eq(appChatMemoryLog.chatId, chat))
    .orderBy(desc(appChatMemoryLog.idx))
    .limit(1)
    .get()

/** Remembers one more message of `chat` at `idx`. */
export const rememberMessage = (
  db: MemoryDb,
  chat: string,
  idx: number,
  entry: { readonly id: number; readonly kind: LogKind },
) => {
  db.insert(appChatMemoryLog).values({ chatId: chat, idx, entryId: entry.id, kind: entry.kind }).run()
}

/** The index of `chat`'s newest message from someone other than the agent, if any. */
export const newestInput = (db: MemoryDb, chat: string): number | undefined =>
  db
    .select({ idx: appChatMemoryLog.idx })
    .from(appChatMemoryLog)
    .where(and(eq(appChatMemoryLog.chatId, chat), eq(appChatMemoryLog.kind, 'user')))
    .orderBy(desc(appChatMemoryLog.idx))
    .limit(1)
    .get()?.idx

/** The text bytes of every built node of `chat`, by node key: all the fold needs. */
export const nodeSizes = (db: MemoryDb, chat: string): Map<string, number> => {
  const rows = db
    .select({ level: appChatMemoryNodes.level, idx: appChatMemoryNodes.idx, bytes: appChatMemoryNodes.bytes })
    .from(appChatMemoryNodes)
    .where(eq(appChatMemoryNodes.chatId, chat))
    .all()
  return new Map(rows.map((row) => [nodeKey({ level: row.level, index: row.idx }), row.bytes]))
}

/** The lines of those of `nodes` that are built, by node key. */
export const nodeTexts = (db: MemoryDb, chat: string, nodes: readonly Node[]): Map<string, string> => {
  const texts = new Map<string, string>()
  for (const level of new Set(nodes.map((node) => node.level))) {
    const indexes = nodes.filter((node) => node.level === level).map((node) => node.index)
    const rows = db
      .select()
      .from(appChatMemoryNodes)
      .where(
        and(
          eq(appChatMemoryNodes.chatId, chat),
          eq(appChatMemoryNodes.level, level),
          inArray(appChatMemoryNodes.idx, indexes),
        ),
      )
      .all()
    for (const row of rows) texts.set(nodeKey({ level: row.level, index: row.idx }), row.text)
  }
  return texts
}

/** Stores `node`'s line once: a node is never rewritten. */
export const storeNode = (
  db: MemoryDb,
  chat: string,
  node: Node,
  line: { readonly text: string; readonly bytes: number },
) => {
  db.insert(appChatMemoryNodes)
    .values({ chatId: chat, level: node.level, idx: node.index, text: line.text, bytes: line.bytes })
    .onConflictDoNothing()
    .run()
}

/**
 * Every Topic's Conversation whose memory has not begun: a fresh agent's Personal, and a Topic whose activation a crash
 * cut short.
 */
export const conversationsWithoutMemory = (db: MemoryDb): readonly string[] =>
  db
    .select({ chat: appConversations.chatId })
    .from(appConversations)
    .leftJoin(appChatMemoryState, eq(appChatMemoryState.chatId, appConversations.chatId))
    .where(
      and(
        or(eq(appConversations.role, 'primary'), eq(appConversations.role, 'conversation')),
        isNull(appChatMemoryState.chatId),
      ),
    )
    .all()
    .map((row) => row.chat)
