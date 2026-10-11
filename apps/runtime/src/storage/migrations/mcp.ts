import { BREAK, type Migration } from './migration.ts'

/** The MCP 2026 client (ADR 0042, keys from `20261030000000_`): added by their own migrations, so dev keeps its data. */
export const MCP_MIGRATIONS: readonly Migration[] = [
  {
    key: '20261030000000_mcp_url_requests',
    tables: ['app_mcp_url_requests'],
    sql: [
      `CREATE TABLE app_mcp_url_requests (id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, source_call_id TEXT NOT NULL, task_id TEXT NOT NULL, connection_id TEXT NOT NULL, name TEXT NOT NULL, endpoint TEXT NOT NULL, arguments_sealed TEXT NOT NULL, arguments_hash TEXT NOT NULL, input_key TEXT NOT NULL, state_sealed TEXT, prompt_sealed TEXT NOT NULL, result_sealed TEXT, state TEXT NOT NULL CHECK (state IN ('pending', 'retrying', 'completed', 'declined', 'expired', 'failed', 'uncertain')), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
      'CREATE INDEX app_mcp_url_request_session ON app_mcp_url_requests (session_id, state)',
    ].join(BREAK),
  },
]
