import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * What happens in a chat by operation (ADR 0030). Pi deduplicates per session; a chat's admission remembers the session
 * an operation was first admitted to, so a replay keeps it. The receipt columns (`20261027000000_chat_operation_receipts`)
 * say what the operation was, who started it, what it led to and how it ended; a row admitted before them has none.
 */
export const appChatOperations = sqliteTable(
  'app_chat_operations',
  {
    chatId: text('chat_id').notNull(),
    operationId: text('operation_id').notNull(),
    sessionId: text('session_id').notNull(),
    admittedAt: integer('admitted_at').notNull(),
    kind: text('kind'),
    origin: text('origin'),
    targetChat: text('target_chat'),
    parentOp: text('parent_op'),
    state: text('state'),
    reason: text('reason'),
    settledAt: integer('settled_at'),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.operationId] })],
)
