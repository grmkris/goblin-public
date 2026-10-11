import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Every notification a routine posted (ADR 0041): its notices, and the answers it was told to notify. It indexes the
 * entry in the routine's home chat for Activity, keeps the owner's read mark, and is the outbox of its Telegram copy.
 * The text is the producer's, frozen as it was posted.
 */
export const appNotices = sqliteTable(
  'app_notices',
  {
    id: text('id').primaryKey().notNull(),
    routineId: text('routine_id').notNull(),
    source: text('source', { enum: ['event', 'reminder', 'report', 'digest'] }).notNull(),
    chatId: text('chat_id').notNull(),
    entryRequestId: text('entry_request_id').notNull(),
    connectionId: text('connection_id'),
    label: text('label').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    url: text('url'),
    /** When it happened (ms). */
    at: integer('at').notNull(),
    readAt: integer('read_at'),
    /** When its entry was written into the chat; a notice claimed but not yet written is written by the sweep. */
    writtenAt: integer('written_at'),
    telegramState: text('telegram_state', { enum: ['none', 'pending', 'accepted', 'suppressed', 'failed'] })
      .notNull()
      .default('none'),
    telegramText: text('telegram_text'),
    telegramAttempts: integer('telegram_attempts').notNull().default(0),
    telegramNextAt: integer('telegram_next_at').notNull().default(0),
    telegramReceipt: text('telegram_receipt'),
    /** The Telegram connection its first attempt went through; a channel changed since suppresses it. */
    telegramConnectionId: text('telegram_connection_id'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('app_notices_at').on(table.at), index('app_notices_routine').on(table.routineId, table.at)],
)

/** Each routine's hour of notices: when it began, how many were posted, and how many past the cap wait for a digest. */
export const appNoticeWindows = sqliteTable('app_notice_windows', {
  routineId: text('routine_id').primaryKey().notNull(),
  startedAt: integer('started_at').notNull(),
  sent: integer('sent').notNull(),
  folded: integer('folded').notNull(),
})
