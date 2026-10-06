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
  {
    // What each conversation switched off for its agent (capabilities/profiles.ts): a row is one thing off there.
    key: '20261016000100_conversation_capabilities',
    tables: ['app_conversation_capabilities'],
    sql: `CREATE TABLE app_conversation_capabilities (session_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('server', 'tool', 'skills', 'subagents')), server_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', off_at INTEGER NOT NULL, PRIMARY KEY (session_id, kind, server_id, name), CHECK ((kind = 'subagents') = (server_id = '')), CHECK ((kind = 'tool') = (name <> '')))`,
  },
  {
    key: '20261016000200_mcp_events',
    tables: [
      'app_mcp_event_grants',
      'app_mcp_event_subscriptions',
      'app_event_deliveries',
      'app_mcp_event_consumers',
      'app_event_consumer_receipts',
      'app_telegram_channel',
      'app_skill_catalog_state',
    ],
    sql: [
      'CREATE TABLE app_mcp_event_grants (server_id TEXT NOT NULL, name TEXT NOT NULL, arguments_json TEXT NOT NULL, granted_at INTEGER NOT NULL, revoked_at INTEGER, PRIMARY KEY (server_id, name, arguments_json))',
      'CREATE TABLE app_mcp_event_subscriptions (id TEXT PRIMARY KEY NOT NULL, server_id TEXT NOT NULL, name TEXT NOT NULL, arguments_json TEXT NOT NULL, endpoint TEXT NOT NULL, principal TEXT NOT NULL, callback_url TEXT NOT NULL, remote_id TEXT, secret TEXT NOT NULL, previous_secret TEXT, grace_until INTEGER, cursor TEXT, refresh_before INTEGER, next_refresh_at INTEGER NOT NULL, next_poll_at INTEGER NOT NULL, status TEXT NOT NULL, last_error TEXT, last_receipt_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
      'CREATE UNIQUE INDEX app_event_selector ON app_mcp_event_subscriptions (server_id, name, arguments_json)',
      'CREATE TABLE app_event_deliveries (subscription_id TEXT NOT NULL, webhook_id TEXT NOT NULL, kind TEXT NOT NULL, envelope TEXT NOT NULL, bytes INTEGER NOT NULL, received_at INTEGER NOT NULL, processed_at INTEGER, next_attempt_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, challenge_response TEXT, challenge_until INTEGER, PRIMARY KEY (subscription_id, webhook_id))',
      'CREATE INDEX app_event_pending ON app_event_deliveries (processed_at, next_attempt_at)',
      'CREATE TABLE app_mcp_event_consumers (consumer_id TEXT NOT NULL, revision INTEGER NOT NULL, subscription_id TEXT NOT NULL, handler_key TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, retired_at INTEGER, PRIMARY KEY (consumer_id, revision))',
      "CREATE UNIQUE INDEX app_event_active_consumer ON app_mcp_event_consumers (consumer_id) WHERE state = 'active'",
      'CREATE TABLE app_event_consumer_receipts (subscription_id TEXT NOT NULL, webhook_id TEXT NOT NULL, consumer_id TEXT NOT NULL, revision INTEGER NOT NULL, operation_id TEXT NOT NULL, state TEXT NOT NULL, accepted_at INTEGER, PRIMARY KEY (subscription_id, webhook_id, consumer_id, revision))',
      'CREATE TABLE app_telegram_channel (id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1), server_id TEXT NOT NULL, inbox_cursor TEXT NOT NULL, enabled_at INTEGER NOT NULL)',
      'CREATE TABLE app_skill_catalog_state (server_id TEXT PRIMARY KEY NOT NULL, dirty_generation INTEGER NOT NULL, refreshed_generation INTEGER NOT NULL, next_retry_at INTEGER NOT NULL, last_error TEXT)',
    ].join(BREAK),
  },
  {
    key: '20261016000210_routines',
    tables: [
      'app_routines',
      'app_routine_operations',
      'app_routine_runs',
      'app_routine_usage',
      'app_routine_settings',
      'app_submission_origins',
      'app_interactions',
      'app_conversations',
    ],
    sql: [
      "CREATE TABLE app_routines (id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('proposed','activating','active','paused','completed','archived')), definition_json TEXT NOT NULL, proposer_user_id TEXT NOT NULL, confirmed_by_user_id TEXT, confirmed_at INTEGER, schedule_id TEXT, next_fire_at INTEGER, last_fire_at INTEGER, missed_count INTEGER NOT NULL DEFAULT 0, pending_trigger TEXT, suppressed_count INTEGER NOT NULL DEFAULT 0, health TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      'CREATE TABLE app_routine_operations (operation_id TEXT PRIMARY KEY NOT NULL, request_json TEXT NOT NULL, response_json TEXT NOT NULL, created_at INTEGER NOT NULL)',
      "CREATE TABLE app_routine_runs (id TEXT PRIMARY KEY NOT NULL, routine_id TEXT NOT NULL, revision INTEGER NOT NULL, operation_id TEXT NOT NULL UNIQUE, source TEXT NOT NULL, fired_at INTEGER NOT NULL, event_id TEXT, subscription_id TEXT, webhook_id TEXT, definition_json TEXT NOT NULL, event_data_sealed TEXT, session_id TEXT UNIQUE, admitted_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('admitted','running','waiting_owner','completed','skipped','failed','stopped')), outcome TEXT, summary TEXT, report_request_id TEXT NOT NULL, report_accepted_at INTEGER, notification_text TEXT, notification_state TEXT NOT NULL DEFAULT 'none', notification_receipt TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      'CREATE TABLE app_routine_usage (run_id TEXT NOT NULL, source_key TEXT NOT NULL, utc_day TEXT NOT NULL, tokens INTEGER NOT NULL, committed_at INTEGER NOT NULL, PRIMARY KEY (run_id, source_key))',
      'CREATE TABLE app_routine_settings (id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1), timezone TEXT NOT NULL, max_active INTEGER NOT NULL DEFAULT 20, max_running INTEGER NOT NULL DEFAULT 2)',
      "INSERT INTO app_routine_settings (id, timezone) VALUES (1, 'UTC')",
      'CREATE TABLE app_submission_origins (session_id TEXT NOT NULL, operation_id TEXT NOT NULL, principal_user_id TEXT NOT NULL, role TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, operation_id))',
      'CREATE TABLE app_interactions (id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, run_id TEXT, call_id TEXT NOT NULL, requester_user_id TEXT NOT NULL, answerer_user_id TEXT NOT NULL, intent TEXT NOT NULL, request_hash TEXT NOT NULL, state TEXT NOT NULL, expires_at INTEGER NOT NULL, decision_operation_id TEXT)',
      'ALTER TABLE app_conversations ADD COLUMN routine_run_id TEXT',
      'CREATE UNIQUE INDEX app_conversation_routine ON app_conversations (routine_run_id)',
      'CREATE INDEX app_routine_live_runs ON app_routine_runs (routine_id, state)',
    ].join(BREAK),
  },
  {
    key: '20261016000211_routine_usage_projection',
    tables: ['app_routine_usage_projection', 'app_routine_answers', 'app_routine_runs'],
    sql: [
      'CREATE TABLE app_routine_usage_projection (run_id TEXT NOT NULL, model TEXT NOT NULL, tokens INTEGER NOT NULL, PRIMARY KEY (run_id, model))',
      'CREATE TABLE app_routine_answers (run_id TEXT NOT NULL, operation_id TEXT NOT NULL, request_json TEXT NOT NULL, interaction_id TEXT NOT NULL, PRIMARY KEY (run_id, operation_id))',
      'ALTER TABLE app_routine_runs ADD COLUMN notification_server_id TEXT',
      'ALTER TABLE app_routine_runs ADD COLUMN notification_attempts INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE app_routine_runs ADD COLUMN notification_next_at INTEGER NOT NULL DEFAULT 0',
    ].join(BREAK),
  },
  {
    key: '20261016000212_routine_event_spacing',
    tables: ['app_routine_runs'],
    sql: 'CREATE INDEX app_routine_event_spacing ON app_routine_runs (source, admitted_at)',
  },
  {
    // One Close replaces archiving; conversations form a tree walked by parent.
    key: '20261017000000_conversation_tree',
    tables: ['app_conversations'],
    sql: [
      'ALTER TABLE app_conversations ADD COLUMN closed_at INTEGER',
      "ALTER TABLE app_conversations ADD COLUMN closed_by TEXT CHECK (closed_by IN ('owner', 'done'))",
      'ALTER TABLE app_conversations ADD COLUMN keep_open_at INTEGER',
      "UPDATE app_conversations SET closed_at = archived_at, closed_by = 'owner' WHERE archived_at IS NOT NULL",
      'CREATE INDEX app_conversation_parent ON app_conversations (parent_session)',
    ].join(BREAK),
  },
  {
    // Dormant leftovers of Members (withdrawn 2026-10-05); applied entries and data stay.
    key: '20261017000001_members_phase_b',
    tables: [
      'app_conversations',
      'app_submission_origins',
      'app_interactions',
      'app_member_journal',
      'app_thread_readers',
    ],
    sql: [
      'ALTER TABLE app_conversations ADD COLUMN principal_user_id TEXT',
      'ALTER TABLE app_conversations ADD COLUMN member_id TEXT',
      'ALTER TABLE app_conversations ADD COLUMN member_version INTEGER',
      'ALTER TABLE app_conversations ADD COLUMN context_epoch INTEGER',
      "ALTER TABLE app_conversations ADD COLUMN member_purpose TEXT CHECK (member_purpose IN ('main', 'private'))",
      "ALTER TABLE app_conversations ADD COLUMN visibility TEXT CHECK (visibility IN ('owner', 'member', 'all'))",
      'CREATE INDEX app_conversation_principal ON app_conversations (principal_user_id, member_id)',
      'ALTER TABLE app_submission_origins ADD COLUMN member_id TEXT',
      'ALTER TABLE app_submission_origins ADD COLUMN member_version INTEGER',
      'ALTER TABLE app_submission_origins ADD COLUMN scope_hash TEXT',
      'ALTER TABLE app_interactions ADD COLUMN member_id TEXT',
      'ALTER TABLE app_interactions ADD COLUMN member_version INTEGER',
      'ALTER TABLE app_interactions ADD COLUMN approval_kind TEXT',
      'ALTER TABLE app_interactions ADD COLUMN consumed_at INTEGER',
      'ALTER TABLE app_interactions ADD COLUMN decision_hash TEXT',
      'ALTER TABLE app_submission_origins ADD COLUMN request_hash TEXT',
      'CREATE TABLE app_member_journal (id INTEGER PRIMARY KEY AUTOINCREMENT, source_key TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, committed_at INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0)',
      'CREATE TABLE app_thread_readers (session_id TEXT NOT NULL, user_id TEXT NOT NULL, granted_by_user_id TEXT NOT NULL, granted_at INTEGER NOT NULL, PRIMARY KEY (session_id, user_id))',
    ].join(BREAK),
  },
  {
    // The owner's read mark: replies after it are unread.
    key: '20261017000100_conversation_read_mark',
    tables: ['app_conversations'],
    sql: 'ALTER TABLE app_conversations ADD COLUMN read_at INTEGER',
  },
  {
    // Dormant Members reader columns; retain the applied migration.
    key: '20261017000234_members_readers',
    tables: ['app_thread_readers'],
    sql: [
      'ALTER TABLE app_thread_readers ADD COLUMN member_id TEXT',
      'ALTER TABLE app_thread_readers ADD COLUMN member_version INTEGER',
    ].join(BREAK),
  },
  {
    // Durable MCP Apps (ADR 0020): one per tool call, never a grant.
    key: '20261017000300_apps',
    tables: ['app_apps'],
    sql: [
      'CREATE TABLE app_apps (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, call_id TEXT NOT NULL, entry_id INTEGER, server_id TEXT NOT NULL, tool TEXT NOT NULL, resource_uri TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, closed_at INTEGER)',
      'CREATE UNIQUE INDEX app_apps_call ON app_apps (session_id, call_id)',
    ].join(BREAK),
  },
  {
    // Agent apps (ADR 0021): releases, state, snapshots, receipts and events.
    key: '20261018000000_agent_apps',
    tables: [
      'app_agent_apps',
      'app_agent_releases',
      'app_agent_artifacts',
      'app_agent_state',
      'app_agent_snapshots',
      'app_agent_receipts',
      'app_agent_events',
    ],
    sql: [
      'CREATE TABLE app_agent_apps (name TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, home_session TEXT NOT NULL, active_release TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
      `CREATE TABLE app_agent_releases (id TEXT PRIMARY KEY NOT NULL, app TEXT NOT NULL, seq INTEGER, status TEXT NOT NULL CHECK (status IN ('active', 'retired', 'failed')), manifest TEXT, source TEXT NOT NULL, toolchain TEXT NOT NULL, diagnostics TEXT, note TEXT, session TEXT, call_id TEXT, created_at INTEGER NOT NULL)`,
      'CREATE INDEX app_agent_releases_app ON app_agent_releases (app, created_at)',
      `CREATE TABLE app_agent_artifacts (release TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('backend')), content TEXT NOT NULL, PRIMARY KEY (release, kind))`,
      'CREATE TABLE app_agent_state (app TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL, release TEXT NOT NULL, updated_at INTEGER NOT NULL)',
      'CREATE TABLE app_agent_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, app TEXT NOT NULL, release TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL)',
      'CREATE INDEX app_agent_snapshots_app ON app_agent_snapshots (app, id)',
      'CREATE TABLE app_agent_receipts (op TEXT PRIMARY KEY NOT NULL, app TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL)',
      'CREATE INDEX app_agent_receipts_created ON app_agent_receipts (created_at)',
      `CREATE TABLE app_agent_events (id INTEGER PRIMARY KEY AUTOINCREMENT, app TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('build', 'failed', 'call', 'error', 'log', 'rollback')), detail TEXT NOT NULL, created_at INTEGER NOT NULL)`,
      'CREATE INDEX app_agent_events_app ON app_agent_events (app, id)',
    ].join(BREAK),
  },
  {
    // One registry for MCP Apps and agent apps (ADR 0021): app_apps copied with the same ids, then no longer read.
    key: '20261018000100_app_registry',
    tables: ['app_registry'],
    sql: [
      `CREATE TABLE app_registry (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL CHECK (source IN ('mcp', 'agent')), session_id TEXT NOT NULL, call_id TEXT, entry_id INTEGER, server_id TEXT, tool TEXT, resource_uri TEXT, name TEXT, title TEXT NOT NULL, created_at INTEGER NOT NULL, closed_at INTEGER, CHECK ((source = 'mcp' AND call_id IS NOT NULL AND server_id IS NOT NULL AND tool IS NOT NULL AND resource_uri IS NOT NULL AND name IS NULL) OR (source = 'agent' AND name IS NOT NULL AND call_id IS NULL AND server_id IS NULL AND tool IS NULL AND resource_uri IS NULL)))`,
      'CREATE UNIQUE INDEX app_registry_call ON app_registry (session_id, call_id)',
      'CREATE UNIQUE INDEX app_registry_name ON app_registry (name)',
      `INSERT INTO app_registry (id, source, session_id, call_id, entry_id, server_id, tool, resource_uri, title, created_at, closed_at) SELECT id, 'mcp', session_id, call_id, entry_id, server_id, tool, resource_uri, title, created_at, closed_at FROM app_apps ORDER BY id`,
    ].join(BREAK),
  },
  {
    // An agent app release's view: its module, stylesheet and frame bundles (ADR 0021).
    key: '20261018000200_agent_app_views',
    tables: ['app_agent_views'],
    sql: 'CREATE TABLE app_agent_views (release TEXT PRIMARY KEY NOT NULL, module TEXT NOT NULL, css TEXT NOT NULL, libs TEXT NOT NULL)',
  },
  {
    // Agent app powers with the owner's approvals, and each app's daily usage (ADR 0021).
    key: '20261018000300_agent_app_powers',
    tables: ['app_agent_powers', 'app_agent_usage'],
    sql: [
      `CREATE TABLE app_agent_powers (app TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('egress', 'tool', 'app', 'llm', 'notify')), target TEXT NOT NULL, requested_by TEXT NOT NULL, approved_at INTEGER, revoked_at INTEGER, PRIMARY KEY (app, kind, target))`,
      `CREATE TABLE app_agent_usage (app TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('egress', 'tokens', 'notify', 'job')), amount INTEGER NOT NULL, PRIMARY KEY (app, day, kind))`,
    ].join(BREAK),
  },
  {
    key: '20261018000400_agent_app_jobs',
    tables: ['app_agent_jobs'],
    sql: `CREATE TABLE app_agent_jobs (app TEXT NOT NULL, action TEXT NOT NULL, every TEXT NOT NULL CHECK (every IN ('15m', '30m', '1h', '3h', '6h', '12h', '1d')), at TEXT, input TEXT NOT NULL, release TEXT NOT NULL, next_at INTEGER NOT NULL, schedule_id TEXT, last_at INTEGER, last_status TEXT CHECK (last_status IN ('ok', 'failed', 'waiting', 'skipped')), last_error TEXT, failures INTEGER NOT NULL DEFAULT 0, paused TEXT CHECK (paused IN ('owner', 'failures')), PRIMARY KEY (app, action))`,
  },
  {
    // The run ledger (ADR 0024): timings and outcomes beside Pi's record, no content.
    key: '20261019000000_run_events',
    tables: ['app_run_events'],
    sql: [
      `CREATE TABLE app_run_events (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('started', 'ok', 'error', 'blocked', 'interrupted')), conversation_id TEXT, operation_id TEXT, task_id TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, attributes TEXT NOT NULL)`,
      'CREATE INDEX app_run_events_operation ON app_run_events (operation_id)',
      'CREATE INDEX app_run_events_conversation ON app_run_events (conversation_id, started_at)',
      'CREATE INDEX app_run_events_task ON app_run_events (task_id, started_at)',
      'CREATE INDEX app_run_events_status ON app_run_events (status, started_at)',
      'CREATE INDEX app_run_events_started ON app_run_events (started_at)',
    ].join(BREAK),
  },
  {
    // An operator's own record of the agents they read (ADR 0024). Dormant since operator access was withdrawn on
    // 2026-10-06: no row was ever written; the table and this history stay, as with Members.
    key: '20261020000000_operator_reads',
    tables: ['app_operator_reads'],
    sql: [
      'CREATE TABLE app_operator_reads (id TEXT PRIMARY KEY NOT NULL, at INTEGER NOT NULL, user_id TEXT NOT NULL, client_id TEXT NOT NULL, client_name TEXT, tool TEXT NOT NULL, arguments TEXT NOT NULL)',
      'CREATE INDEX app_operator_reads_at ON app_operator_reads (at)',
    ].join(BREAK),
  },
  {
    key: '20261021000000_home',
    tables: ['app_home', 'app_home_operations'],
    sql: [
      'CREATE TABLE app_home (id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1), revision INTEGER NOT NULL, layout TEXT NOT NULL)',
      "CREATE TABLE app_home_operations (operation_id TEXT PRIMARY KEY NOT NULL, actor TEXT NOT NULL CHECK (actor IN ('owner', 'agent')), result TEXT NOT NULL, before TEXT NOT NULL)",
    ].join(BREAK),
  },
]

export function runApplicationMigrations(storage: DurableObjectStorage): void {
  for (const migration of MIGRATIONS) for (const table of migration.tables) assertApplicationTable(table)
  migrate(drizzle(storage), {
    migrations: Object.fromEntries(MIGRATIONS.map((migration) => [migration.key, migration.sql])),
  })
}
