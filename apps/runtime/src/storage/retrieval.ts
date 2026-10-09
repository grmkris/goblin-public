import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * The cross-Topic transcript index (ADR 0035): one bounded, redacted excerpt per indexed Pi entry, keyed by the entry's
 * global id. `session_id` is the Pi session that owns the entry; `chat_id` the chat it belongs to now (a Move
 * reassigns it). The FTS5 table `app_transcript_fts` mirrors `text` through triggers (external content); its shadow
 * tables are `app_transcript_fts_*`. Raw SQL reads it, since Drizzle has no virtual-table builder.
 */
export const appTranscriptExcerpts = sqliteTable(
  'app_transcript_excerpts',
  {
    entryId: integer('entry_id').primaryKey().notNull(),
    sessionId: text('session_id').notNull(),
    chatId: text('chat_id').notNull(),
    role: text('role').notNull(),
    author: text('author'),
    at: integer('at').notNull(),
    text: text('text').notNull(),
  },
  (table) => [
    index('app_transcript_excerpts_chat').on(table.chatId, table.entryId),
    index('app_transcript_excerpts_session').on(table.sessionId, table.entryId),
  ],
)

/** How far each Pi session is indexed: every owned entry up to `through_entry` (inclusive) has been read. */
export const appTranscriptIndex = sqliteTable('app_transcript_index', {
  sessionId: text('session_id').primaryKey().notNull(),
  throughEntry: integer('through_entry').notNull(),
  checkedAt: integer('checked_at').notNull(),
})

/**
 * What a run actually used (frozen evidence): the sources a `search_chats` call returned or automatic retrieval
 * injected, keyed by a stable id (the tool call, or the input it served) so a replay finds the same record.
 */
export const appRetrievalUses = sqliteTable(
  'app_retrieval_uses',
  {
    id: text('id').primaryKey().notNull(),
    chatId: text('chat_id').notNull(),
    sessionId: text('session_id').notNull(),
    inputEntry: integer('input_entry'),
    mode: text('mode', { enum: ['tool', 'auto'] }).notNull(),
    sources: text('sources').notNull(),
    retrievedAt: integer('retrieved_at').notNull(),
  },
  (table) => [index('app_retrieval_uses_chat').on(table.chatId, table.retrievedAt)],
)
