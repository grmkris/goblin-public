import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Each Topic Conversation's memory (ADR 0032), keyed by chat id: the messages it remembers in order (`idx`, the Pi
 * entry and its kind), the summary tree over them (`memory/tree.ts`: node (level, idx) and its line, never rewritten),
 * and its state (its newest entry when it began, how far its newest view reaches). The agent-wide `app_memory_*`
 * tables they were copied from (into chat `1`) stay in SQLite, no longer read.
 */
export const appChatMemoryLog = sqliteTable(
  'app_chat_memory_log',
  {
    chatId: text('chat_id').notNull(),
    idx: integer('idx').notNull(),
    entryId: integer('entry_id').notNull(),
    kind: text('kind', { enum: ['user', 'talk', 'echo'] }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.idx] })],
)

export const appChatMemoryNodes = sqliteTable(
  'app_chat_memory_nodes',
  {
    chatId: text('chat_id').notNull(),
    level: integer('level').notNull(),
    idx: integer('idx').notNull(),
    text: text('text').notNull(),
    bytes: integer('bytes').notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.level, table.idx] })],
)

export const appChatMemoryState = sqliteTable('app_chat_memory_state', {
  chatId: text('chat_id').primaryKey().notNull(),
  originEntry: integer('origin_entry').notNull(),
  viewThrough: integer('view_through').notNull(),
})
