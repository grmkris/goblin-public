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

/** Pi session per inbound MCP client: each client talks to the agent in its own conversation. */
export const appClientSessions = sqliteTable('app_client_sessions', {
  clientId: text('client_id').primaryKey().notNull(),
  sessionId: text('session_id').notNull(),
  clientName: text('client_name'),
  createdAt: integer('created_at').notNull(),
})
