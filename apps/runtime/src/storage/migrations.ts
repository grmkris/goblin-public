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
  {
    key: '20261009000000_mcp_added_servers',
    tables: ['app_mcp_servers'],
    sql: 'CREATE TABLE app_mcp_servers (server_id TEXT PRIMARY KEY NOT NULL, endpoint TEXT NOT NULL, title TEXT, description TEXT, icon TEXT, source TEXT, created_at INTEGER NOT NULL)',
  },
  {
    key: '20261010000000_mcp_registries',
    tables: ['app_mcp_registries'],
    sql: 'CREATE TABLE app_mcp_registries (url TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, added_at INTEGER NOT NULL)',
  },
  {
    // Inbound clients now talk in the main conversation, so their per-client sessions go.
    key: '20261011000000_conversations',
    tables: ['app_conversations', 'app_client_sessions'],
    sql: [
      `CREATE TABLE app_conversations (session_id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('main', 'thread', 'subagent')), title TEXT, parent_session TEXT, fork_entry INTEGER, created_at INTEGER NOT NULL, archived_at INTEGER)`,
      'DROP TABLE app_client_sessions',
    ].join(BREAK),
  },
  {
    key: '20261012000000_memory',
    tables: ['app_memory_log', 'app_memory_nodes', 'app_memory_state', 'app_conversations'],
    sql: [
      `CREATE TABLE app_memory_log (idx INTEGER PRIMARY KEY NOT NULL, entry_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('user', 'talk', 'echo')))`,
      'CREATE TABLE app_memory_nodes (level INTEGER NOT NULL, idx INTEGER NOT NULL, text TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (level, idx))',
      'CREATE TABLE app_memory_state (id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1), origin_entry INTEGER NOT NULL, view_through INTEGER NOT NULL)',
      'ALTER TABLE app_conversations ADD COLUMN recall_through INTEGER',
    ].join(BREAK),
  },
  {
    // Skills over MCP: the servers the owner uses skills from, what each conversation activated, verified file bytes.
    key: '20261013000000_skills',
    tables: ['app_skill_sources', 'app_skill_activations', 'app_skill_files'],
    sql: [
      'CREATE TABLE app_skill_sources (server_id TEXT PRIMARY KEY NOT NULL, enabled_at INTEGER NOT NULL)',
      'CREATE TABLE app_skill_activations (session_id TEXT NOT NULL, server_id TEXT NOT NULL, uri TEXT NOT NULL, entry TEXT NOT NULL, activated_at INTEGER NOT NULL, PRIMARY KEY (session_id, server_id, uri))',
      'CREATE TABLE app_skill_files (digest TEXT PRIMARY KEY NOT NULL, content TEXT NOT NULL, stored_at INTEGER NOT NULL)',
    ].join(BREAK),
  },
  {
    // Drafts the agent proposed to a skills library (skills/learner.ts): never the same twice, never a rejected one again.
    key: '20261014000000_skill_drafts',
    tables: ['app_skill_drafts'],
    sql: "CREATE TABLE app_skill_drafts (content_hash TEXT PRIMARY KEY NOT NULL, server_id TEXT NOT NULL, name TEXT NOT NULL, base_uri TEXT, draft_id TEXT, status TEXT NOT NULL CHECK (status IN ('open', 'accepted', 'rejected')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  },
  {
    // The Telegram channel (channel/channel.ts): the one connection that carries it, its inbox cursor and doorbell
    // secret, and the turns of main whose answers go back to Telegram.
    key: '20261015000000_channel',
    tables: ['app_channel', 'app_channel_replies'],
    sql: [
      'CREATE TABLE app_channel (id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1), server_id TEXT NOT NULL, cursor TEXT NOT NULL, secret TEXT NOT NULL, enabled_at INTEGER NOT NULL)',
      'CREATE TABLE app_channel_replies (operation_id TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, delivered_at INTEGER)',
    ].join(BREAK),
  },
  {
    // A thread the owner started with "+" owes main one note naming it once it has a title.
    key: '20261016000000_thread_notes',
    tables: ['app_conversations'],
    sql: "ALTER TABLE app_conversations ADD COLUMN main_note TEXT CHECK (main_note IN ('owed', 'written'))",
  },
]

export function runApplicationMigrations(storage: DurableObjectStorage): void {
  for (const migration of MIGRATIONS) for (const table of migration.tables) assertApplicationTable(table)
  migrate(drizzle(storage), {
    migrations: Object.fromEntries(MIGRATIONS.map((migration) => [migration.key, migration.sql])),
  })
}
