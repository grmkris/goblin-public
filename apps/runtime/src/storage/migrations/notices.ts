import { BREAK, type Migration } from './migration.ts'

/** Notices and their notifications (ADR 0041, keys from `20261029000000_`). */
export const NOTICE_MIGRATIONS: readonly Migration[] = [
  {
    key: '20261029000000_notices',
    tables: ['app_notices', 'app_notice_windows'],
    sql: [
      `CREATE TABLE app_notices (id TEXT PRIMARY KEY NOT NULL, routine_id TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('event', 'reminder', 'report', 'digest')), chat_id TEXT NOT NULL, entry_request_id TEXT NOT NULL, connection_id TEXT, label TEXT NOT NULL, title TEXT NOT NULL, body TEXT, url TEXT, at INTEGER NOT NULL, read_at INTEGER, written_at INTEGER, telegram_state TEXT NOT NULL DEFAULT 'none' CHECK (telegram_state IN ('none', 'pending', 'accepted', 'suppressed', 'failed')), telegram_text TEXT, telegram_attempts INTEGER NOT NULL DEFAULT 0, telegram_next_at INTEGER NOT NULL DEFAULT 0, telegram_receipt TEXT, telegram_connection_id TEXT, created_at INTEGER NOT NULL)`,
      'CREATE INDEX app_notices_at ON app_notices (at)',
      'CREATE INDEX app_notices_routine ON app_notices (routine_id, at)',
      'CREATE TABLE app_notice_windows (routine_id TEXT PRIMARY KEY NOT NULL, started_at INTEGER NOT NULL, sent INTEGER NOT NULL, folded INTEGER NOT NULL)',
    ].join(BREAK),
  },
]
