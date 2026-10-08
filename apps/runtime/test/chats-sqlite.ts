import { DatabaseSync } from 'node:sqlite'
import { drizzle } from 'drizzle-orm/node-sqlite'

/** Real SQLite for directory unit tests; native integrations separately exercise the Durable Object driver. */
export function chatDatabase() {
  const sqlite = new DatabaseSync(':memory:')
  const db = drizzle({ client: sqlite })
  sqlite.exec(`CREATE TABLE app_conversations (
    session_id TEXT PRIMARY KEY, pi_session TEXT UNIQUE, epoch INTEGER NOT NULL DEFAULT 0,
    role TEXT, spawner_session TEXT, kind TEXT NOT NULL, title TEXT, parent_session TEXT,
    fork_entry INTEGER, created_at INTEGER NOT NULL, closed_at INTEGER, closed_by TEXT,
    keep_open_at INTEGER, read_at INTEGER, recall_through INTEGER, main_note TEXT, routine_run_id TEXT);
    CREATE TABLE app_chat_operations (chat_id TEXT, operation_id TEXT, session_id TEXT, admitted_at INTEGER,
    PRIMARY KEY(chat_id, operation_id));`)
  return { db, close: () => sqlite.close() }
}
