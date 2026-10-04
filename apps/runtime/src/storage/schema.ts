import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Pi owns conversations; these tables hold application state only. Every name keeps the `app_` prefix. */
export const appMetadata = sqliteTable('app_metadata', {
  id: text('id').primaryKey().notNull(),
  value: text('value').notNull(),
})

/** Owner grants: exactly which tool, resource or prompt of a configured server may be used. */
export const appMcpGrants = sqliteTable(
  'app_mcp_grants',
  {
    serverId: text('server_id').notNull(),
    capability: text('capability', { enum: ['tool', 'resource', 'prompt'] }).notNull(),
    name: text('name').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.serverId, table.capability, table.name] })],
)

/**
 * The endpoint each server id's credentials and grants were made for (mcp/endpoints.ts). Kept apart from the
 * credentials, which a disconnect deletes, so grants stay bound too.
 */
export const appMcpEndpoints = sqliteTable('app_mcp_endpoints', {
  serverId: text('server_id').primaryKey().notNull(),
  endpoint: text('endpoint').notNull(),
  boundAt: integer('bound_at').notNull(),
})

/**
 * Servers the owner added (mcp/servers.ts), beside the deployment's configured ones. Title, description and icon are
 * the server's own claims from its card or registry entry; `source` records where it was found.
 */
export const appMcpServers = sqliteTable('app_mcp_servers', {
  serverId: text('server_id').primaryKey().notNull(),
  endpoint: text('endpoint').notNull(),
  title: text('title'),
  description: text('description'),
  icon: text('icon'),
  source: text('source'),
  createdAt: integer('created_at').notNull(),
})

/** MCP registries the owner added to search (mcp/registries.ts), after the built-in ones. */
export const appMcpRegistries = sqliteTable('app_mcp_registries', {
  url: text('url').primaryKey().notNull(),
  title: text('title').notNull(),
  addedAt: integer('added_at').notNull(),
})

/** Outbound OAuth state per server. `client_info` and `tokens` are AES-GCM ciphertext (mcp/credentials.ts). */
export const appMcpCredentials = sqliteTable('app_mcp_credentials', {
  serverId: text('server_id').primaryKey().notNull(),
  status: text('status', { enum: ['connected', 'needs_auth'] }).notNull(),
  clientInfo: text('client_info'),
  tokens: text('tokens'),
  discovery: text('discovery'),
  tokenExpiresAt: integer('token_expires_at'),
  updatedAt: integer('updated_at').notNull(),
})

/** In-flight authorization requests, keyed by OAuth `state`; the PKCE verifier is ciphertext. */
export const appMcpOauthPending = sqliteTable('app_mcp_oauth_pending', {
  state: text('state').primaryKey().notNull(),
  serverId: text('server_id').notNull(),
  codeVerifier: text('code_verifier').notNull(),
  createdAt: integer('created_at').notNull(),
})

/** The single resident-authority row (id 1): whether the agent may act on its own. */
export const appResident = sqliteTable('app_resident', {
  id: integer('id').primaryKey().notNull(),
  renewedAt: integer('renewed_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  revokedAt: integer('revoked_at'),
})
/** Model tokens this agent spent per UTC day (`YYYY-MM-DD`), for the per-user budget. */
export const appUsageDaily = sqliteTable('app_usage_daily', {
  day: text('day').primaryKey().notNull(),
  tokens: integer('tokens').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

/**
 * The conversations the owner can reach, keyed by Pi session id: main (Pi's root), threads and subagents. Pi owns
 * their transcripts; this is only what Pi does not keep: kind, title, where it came from, and whether it is archived.
 */
export const appConversations = sqliteTable('app_conversations', {
  sessionId: text('session_id').primaryKey().notNull(),
  kind: text('kind', { enum: ['main', 'thread', 'subagent'] }).notNull(),
  title: text('title'),
  parentSession: text('parent_session'),
  forkEntry: integer('fork_entry'),
  createdAt: integer('created_at').notNull(),
  archivedAt: integer('archived_at'),
  /** A thread branched from main may zoom into main's memory below this message (the memory's size at the fork). */
  recallThrough: integer('recall_through'),
})

/** Main's memory log: the messages it covers, in order, each pointing at its Pi entry (`memory/log.ts`). */
export const appMemoryLog = sqliteTable('app_memory_log', {
  idx: integer('idx').primaryKey().notNull(),
  entryId: integer('entry_id').notNull(),
  kind: text('kind', { enum: ['user', 'talk', 'echo'] }).notNull(),
})

/** The summary tree over the log (`memory/tree.ts`): node (level, idx) and its line. Never rewritten. */
export const appMemoryNodes = sqliteTable(
  'app_memory_nodes',
  {
    level: integer('level').notNull(),
    idx: integer('idx').notNull(),
    text: text('text').notNull(),
    bytes: integer('bytes').notNull(),
  },
  (table) => [primaryKey({ columns: [table.level, table.idx] })],
)

/** Main's memory (one row, id 1): main's newest entry when it began, and how far its newest view reaches. */
export const appMemoryState = sqliteTable('app_memory_state', {
  id: integer('id').primaryKey().notNull(),
  originEntry: integer('origin_entry').notNull(),
  viewThrough: integer('view_through').notNull(),
})

/** The user's model pick (one row, id 1); none means the deployment default (`models.ts`). */
export const appModelChoice = sqliteTable('app_model_choice', {
  id: integer('id').primaryKey().notNull(),
  modelId: text('model_id').notNull(),
  updatedAt: integer('updated_at').notNull(),
})
