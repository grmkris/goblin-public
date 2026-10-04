import { drizzle } from 'drizzle-orm/durable-sqlite'
import { migrate } from 'drizzle-orm/durable-sqlite/migrator'
import { assertApplicationTable } from './vendor.ts'

const BREAK = '\n--> statement-breakpoint\n'

/** Additive, inline migrations keyed `<14-digit timestamp>_<name>`. Pi/Agents tables are never touched. */
const MIGRATIONS: readonly { readonly key: string; readonly tables: readonly string[]; readonly sql: string }[] = [
  {
    key: '20261004000000_initial',
    tables: ['app_metadata'],
    sql: 'CREATE TABLE IF NOT EXISTS app_metadata (id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)',
  },
  {
    key: '20261005000000_resident_mcp_host',
    tables: ['app_mcp_grants', 'app_mcp_credentials', 'app_mcp_oauth_pending', 'app_resident', 'app_client_sessions'],
    sql: [
      `CREATE TABLE app_mcp_grants (server_id TEXT NOT NULL, capability TEXT NOT NULL CHECK (capability IN ('tool', 'resource', 'prompt')), name TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (server_id, capability, name))`,
      `CREATE TABLE app_mcp_credentials (server_id TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL CHECK (status IN ('connected', 'needs_auth')), client_info TEXT, tokens TEXT, discovery TEXT, token_expires_at INTEGER, updated_at INTEGER NOT NULL)`,
      `CREATE TABLE app_mcp_oauth_pending (state TEXT PRIMARY KEY NOT NULL, server_id TEXT NOT NULL, code_verifier TEXT NOT NULL, created_at INTEGER NOT NULL)`,
      `CREATE TABLE app_resident (id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1), renewed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER)`,
      `CREATE TABLE app_client_sessions (client_id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, client_name TEXT, created_at INTEGER NOT NULL)`,
    ].join(BREAK),
  },
  {
    key: '20261006000000_model_budget',
    tables: ['app_usage_daily'],
    sql: 'CREATE TABLE app_usage_daily (day TEXT PRIMARY KEY NOT NULL, tokens INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
  },
  {
    key: '20261007000000_model_choice',
    tables: ['app_model_choice'],
    sql: 'CREATE TABLE app_model_choice (id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1), model_id TEXT NOT NULL, updated_at INTEGER NOT NULL)',
  },
  {
    key: '20261008000000_mcp_endpoints',
    tables: ['app_mcp_endpoints'],
    sql: 'CREATE TABLE app_mcp_endpoints (server_id TEXT PRIMARY KEY NOT NULL, endpoint TEXT NOT NULL, bound_at INTEGER NOT NULL)',
  },
]

export function runApplicationMigrations(storage: DurableObjectStorage): void {
  for (const migration of MIGRATIONS) for (const table of migration.tables) assertApplicationTable(table)
  migrate(drizzle(storage), {
    migrations: Object.fromEntries(MIGRATIONS.map((migration) => [migration.key, migration.sql])),
  })
}
