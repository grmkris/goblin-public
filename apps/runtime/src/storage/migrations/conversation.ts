import { BREAK, type Migration } from './migration.ts'

/** Lane C's conversation-operation migrations (keys from `20261027000000_`), after the base ones. */
export const CONVERSATION_MIGRATIONS: readonly Migration[] = [
  {
    // Receipts (plan §3): what each operation in a chat was, who started it, what it led to and how it ended. Rows
    // admitted before carry none of it and read as `legacy`; the key, the retention and the first session are unchanged.
    key: '20261027000000_chat_operation_receipts',
    tables: ['app_chat_operations'],
    sql: [
      'ALTER TABLE app_chat_operations ADD COLUMN kind TEXT',
      'ALTER TABLE app_chat_operations ADD COLUMN origin TEXT',
      'ALTER TABLE app_chat_operations ADD COLUMN target_chat TEXT',
      'ALTER TABLE app_chat_operations ADD COLUMN parent_op TEXT',
      'ALTER TABLE app_chat_operations ADD COLUMN state TEXT',
      'ALTER TABLE app_chat_operations ADD COLUMN reason TEXT',
      'ALTER TABLE app_chat_operations ADD COLUMN settled_at INTEGER',
      'CREATE INDEX app_chat_operations_operation ON app_chat_operations (operation_id)',
      'CREATE INDEX app_chat_operations_parent ON app_chat_operations (parent_op)',
    ].join(BREAK),
  },
]
