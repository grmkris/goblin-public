import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

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
 * The conversations the owner can reach, keyed by Pi session id: main (Pi's root), threads and subagents, as a tree
 * through `parent_session` (where a thread branched from, a subagent's spawner). Pi owns their transcripts; this is
 * only what Pi does not keep: kind, title, where it came from, and whether it is closed. The retired `archived_at`
 * column stays in the table (migrations are additive) and is no longer read.
 */
export const appConversations = sqliteTable('app_conversations', {
  sessionId: text('session_id').primaryKey().notNull(),
  kind: text('kind', { enum: ['main', 'thread', 'subagent'] }).notNull(),
  title: text('title'),
  parentSession: text('parent_session'),
  forkEntry: integer('fork_entry'),
  createdAt: integer('created_at').notNull(),
  /** Closed with everything under it: stays readable, refuses its spawner, reopens. Main is never closed. */
  closedAt: integer('closed_at'),
  closedBy: text('closed_by', { enum: ['owner', 'done'] }),
  /** The owner engaged with a subagent (wrote to it, branched from it, pinned it), so it does not close itself. */
  keepOpenAt: integer('keep_open_at'),
  /** When the owner last saw the conversation's newest reply; replies after it are unread. */
  readAt: integer('read_at'),
  /** A thread branched from main may zoom into main's memory below this message (the memory's size at the fork). */
  recallThrough: integer('recall_through'),
  /** A thread the owner started with "+" owes main a note naming it (`owed`) until that note is in (`written`). */
  mainNote: text('main_note', { enum: ['owed', 'written'] }),
  routineRunId: text('routine_run_id'),
})

/**
 * What each conversation switched off for its agent (ADR 0010): one row per thing off there, so anything granted later
 * is on everywhere. `server_id` is empty for `subagents`; `name` is set only for a `tool`.
 */
export const appConversationCapabilities = sqliteTable(
  'app_conversation_capabilities',
  {
    sessionId: text('session_id').notNull(),
    kind: text('kind', { enum: ['server', 'tool', 'skills', 'subagents'] }).notNull(),
    serverId: text('server_id').notNull().default(''),
    name: text('name').notNull().default(''),
    offAt: integer('off_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.kind, table.serverId, table.name] })],
)

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

/** Servers the owner uses skills from (skills/store.ts). A skill is a procedure; only these servers' are followed. */
export const appSkillSources = sqliteTable('app_skill_sources', {
  serverId: text('server_id').primaryKey().notNull(),
  enabledAt: integer('enabled_at').notNull(),
})

/** The skill entry each conversation activated, kept as loaded: its manifest pins the bytes later reads must match. */
export const appSkillActivations = sqliteTable(
  'app_skill_activations',
  {
    sessionId: text('session_id').notNull(),
    serverId: text('server_id').notNull(),
    uri: text('uri').notNull(),
    entry: text('entry').notNull(),
    activatedAt: integer('activated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.serverId, table.uri] })],
)

/** Verified skill file bytes (base64) by digest; re-verified on every read, so a changed row is never used. */
export const appSkillFiles = sqliteTable('app_skill_files', {
  digest: text('digest').primaryKey().notNull(),
  content: text('content').notNull(),
  storedAt: integer('stored_at').notNull(),
})

/** Skill drafts the agent proposed (skills/learner.ts), by content hash: one proposal per content, ever. */
export const appSkillDrafts = sqliteTable('app_skill_drafts', {
  contentHash: text('content_hash').primaryKey().notNull(),
  serverId: text('server_id').notNull(),
  name: text('name').notNull(),
  baseUri: text('base_uri'),
  draftId: text('draft_id'),
  status: text('status', { enum: ['open', 'accepted', 'rejected'] }).notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

/** The Telegram channel (channel/channel.ts): at most one row, the connection that carries it. */
export const appChannel = sqliteTable('app_channel', {
  id: integer('id').primaryKey(),
  serverId: text('server_id').notNull(),
  cursor: text('cursor').notNull(),
  /** The doorbell secret, sealed with the credential key. */
  secret: text('secret').notNull(),
  enabledAt: integer('enabled_at').notNull(),
})

/** Turns of main whose answers go back to Telegram, until they are sent. */
export const appChannelReplies = sqliteTable('app_channel_replies', {
  operationId: text('operation_id').primaryKey().notNull(),
  createdAt: integer('created_at').notNull(),
  deliveredAt: integer('delivered_at'),
})

/** Exact owner Events grants, independent of tools and remote subscription ids. */
export const appMcpEventGrants = sqliteTable(
  'app_mcp_event_grants',
  {
    serverId: text('server_id').notNull(),
    name: text('name').notNull(),
    argumentsJson: text('arguments_json').notNull(),
    grantedAt: integer('granted_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.name, t.argumentsJson] })],
)

/** Endpoint-bound finite leases. Secrets are ciphertext bound to server, subscription and purpose. */
export const appMcpEventSubscriptions = sqliteTable(
  'app_mcp_event_subscriptions',
  {
    id: text('id').primaryKey().notNull(),
    serverId: text('server_id').notNull(),
    name: text('name').notNull(),
    argumentsJson: text('arguments_json').notNull(),
    endpoint: text('endpoint').notNull(),
    principal: text('principal').notNull(),
    callbackUrl: text('callback_url').notNull(),
    remoteId: text('remote_id'),
    secret: text('secret').notNull(),
    previousSecret: text('previous_secret'),
    graceUntil: integer('grace_until'),
    cursor: text('cursor'),
    refreshBefore: integer('refresh_before'),
    nextRefreshAt: integer('next_refresh_at').notNull(),
    nextPollAt: integer('next_poll_at').notNull(),
    status: text('status', { enum: ['pending', 'active', 'catching_up', 'terminated', 'tombstone'] }).notNull(),
    lastError: text('last_error'),
    lastReceiptAt: integer('last_receipt_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('app_event_selector').on(t.serverId, t.name, t.argumentsJson)],
)

/** Encrypted deliveries and their frozen consumer revisions; never prune unfinished work. */
export const appEventDeliveries = sqliteTable(
  'app_event_deliveries',
  {
    subscriptionId: text('subscription_id').notNull(),
    webhookId: text('webhook_id').notNull(),
    kind: text('kind').notNull(),
    envelope: text('envelope').notNull(),
    bytes: integer('bytes').notNull(),
    receivedAt: integer('received_at').notNull(),
    processedAt: integer('processed_at'),
    nextAttemptAt: integer('next_attempt_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    challengeResponse: text('challenge_response'),
    challengeUntil: integer('challenge_until'),
  },
  (t) => [primaryKey({ columns: [t.subscriptionId, t.webhookId] })],
)

/** Static handlers only. A revision stays recoverable after its binding retires. */
export const appMcpEventConsumers = sqliteTable(
  'app_mcp_event_consumers',
  {
    consumerId: text('consumer_id').notNull(),
    revision: integer('revision').notNull(),
    subscriptionId: text('subscription_id').notNull(),
    handlerKey: text('handler_key').notNull(),
    state: text('state', { enum: ['active', 'retiring'] }).notNull(),
    createdAt: integer('created_at').notNull(),
    retiredAt: integer('retired_at'),
  },
  (t) => [primaryKey({ columns: [t.consumerId, t.revision] })],
)

export const appEventConsumerReceipts = sqliteTable(
  'app_event_consumer_receipts',
  {
    subscriptionId: text('subscription_id').notNull(),
    webhookId: text('webhook_id').notNull(),
    consumerId: text('consumer_id').notNull(),
    revision: integer('revision').notNull(),
    operationId: text('operation_id').notNull(),
    state: text('state', { enum: ['pending', 'accepted', 'retired'] }).notNull(),
    acceptedAt: integer('accepted_at'),
  },
  (t) => [primaryKey({ columns: [t.subscriptionId, t.webhookId, t.consumerId, t.revision] })],
)

/** The Events checkpoint fences historical doorbell cursor writes. Reply operation ids do not change. */
export const appTelegramChannel = sqliteTable('app_telegram_channel', {
  id: integer('id').primaryKey().notNull(),
  serverId: text('server_id').notNull(),
  inboxCursor: text('inbox_cursor').notNull(),
  enabledAt: integer('enabled_at').notNull(),
})

/** A newer invalidation cannot be cleared by an older listing response. */
export const appSkillCatalogState = sqliteTable('app_skill_catalog_state', {
  serverId: text('server_id').primaryKey().notNull(),
  dirtyGeneration: integer('dirty_generation').notNull(),
  refreshedGeneration: integer('refreshed_generation').notNull(),
  nextRetryAt: integer('next_retry_at').notNull(),
  lastError: text('last_error'),
})

/** Agent apps (ADR 0021): what the agent built, by name, with its active release and its home conversation. */
export const appAgentApps = sqliteTable('app_agent_apps', {
  name: text('name').primaryKey(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  homeSession: text('home_session').notNull(),
  activeRelease: text('active_release').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

/** Every build of an app: its sources and manifest, active, retired (rollback targets) or failed with diagnostics. */
export const appAgentReleases = sqliteTable(
  'app_agent_releases',
  {
    id: text('id').primaryKey(),
    app: text('app').notNull(),
    seq: integer('seq'),
    status: text('status', { enum: ['active', 'retired', 'failed'] }).notNull(),
    manifest: text('manifest'),
    source: text('source').notNull(),
    toolchain: text('toolchain').notNull(),
    diagnostics: text('diagnostics'),
    note: text('note'),
    session: text('session'),
    callId: text('call_id'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('app_agent_releases_app').on(table.app, table.createdAt)],
)

/** A release's built code, kept apart from its row (Durable Object SQLite rows stay small). */
export const appAgentArtifacts = sqliteTable(
  'app_agent_artifacts',
  {
    release: text('release').notNull(),
    kind: text('kind', { enum: ['backend'] }).notNull(),
    content: text('content').notNull(),
  },
  (table) => [primaryKey({ columns: [table.release, table.kind] })],
)

/** A release's view: its module, stylesheet and frame bundles (`libs`, JSON), apart from its row like its code. */
export const appAgentViews = sqliteTable('app_agent_views', {
  release: text('release').primaryKey(),
  module: text('module').notNull(),
  css: text('css').notNull(),
  libs: text('libs').notNull(),
})

/** An app's state and its revision, which moves by one with every change. */
export const appAgentState = sqliteTable('app_agent_state', {
  app: text('app').primaryKey(),
  revision: integer('revision').notNull(),
  state: text('state').notNull(),
  release: text('release').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

/** The state as it was when another release took over, the last ten per app: what a rollback can return to. */
export const appAgentSnapshots = sqliteTable(
  'app_agent_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    app: text('app').notNull(),
    release: text('release').notNull(),
    revision: integer('revision').notNull(),
    state: text('state').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('app_agent_snapshots_app').on(table.app, table.id)],
)

/** What a call with a stable operation id returned, so its replay returns the same (seven days). */
export const appAgentReceipts = sqliteTable(
  'app_agent_receipts',
  {
    op: text('op').primaryKey(),
    app: text('app').notNull(),
    result: text('result').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('app_agent_receipts_created').on(table.createdAt)],
)

/** What happened to an app, newest last: builds, calls, errors and its own log lines, the last 200 per app. */
export const appAgentEvents = sqliteTable(
  'app_agent_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    app: text('app').notNull(),
    kind: text('kind', { enum: ['build', 'failed', 'call', 'error', 'log', 'rollback'] }).notNull(),
    detail: text('detail').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('app_agent_events_app').on(table.app, table.id)],
)

/**
 * Every App the workspace shows (ADRs 0020, 0021), one id space for both kinds: an MCP App kept from a tool call
 * (`source = 'mcp'`: call, server, tool, resource; `entry_id` is where the call sits in Pi, once found), or an agent
 * app (`'agent'`: its name). It records where an App comes from and what to call it, never a grant. The retired
 * `app_apps` table, its earlier MCP-only form, was copied here with the same ids and is no longer read.
 */
export const appRegistry = sqliteTable(
  'app_registry',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    source: text('source', { enum: ['mcp', 'agent'] }).notNull(),
    sessionId: text('session_id').notNull(),
    callId: text('call_id'),
    entryId: integer('entry_id'),
    serverId: text('server_id'),
    tool: text('tool'),
    resourceUri: text('resource_uri'),
    name: text('name'),
    title: text('title').notNull(),
    createdAt: integer('created_at').notNull(),
    closedAt: integer('closed_at'),
  },
  (table) => [
    uniqueIndex('app_registry_call').on(table.sessionId, table.callId),
    uniqueIndex('app_registry_name').on(table.name),
  ],
)
