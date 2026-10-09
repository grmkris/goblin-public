import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Pi deduplicates per session; chat admission remembers the original session across future rebinds. */
export const appChatOperations = sqliteTable(
  'app_chat_operations',
  {
    chatId: text('chat_id').notNull(),
    operationId: text('operation_id').notNull(),
    sessionId: text('session_id').notNull(),
    admittedAt: integer('admitted_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.operationId] })],
)
