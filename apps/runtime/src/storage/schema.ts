import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
export { appChatOperations } from './chat-operations.ts'
export { appHome, appHomeOperations } from './home-schema.ts'

/** Pi owns conversations; these tables hold application state only. Every name keeps the `app_` prefix. */
export const appMetadata = sqliteTable('app_metadata', {
  id: text('id').primaryKey().notNull(),
  value: text('value').notNull(),
})

/** Owner grants: exactly which tool, resource or prompt of a configured server may be used. */
export const appMcpGrants = sqliteTable(
  'app_mcp_grants',
  {
    connectionId: text('connection_id').notNull(),
    capability: text('capability', { enum: ['tool', 'resource', 'prompt'] }).notNull(),
    name: text('name').notNull(),
    askFirst: integer('ask_first', { mode: 'boolean' }).notNull().default(false),
    version: text('version').notNull().default(''),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.connectionId, table.capability, table.name] })],
)

/**
 * The endpoint each server id's credentials and grants were made for (mcp/endpoints.ts). Kept apart from the
 * credentials, which a disconnect deletes, so grants stay bound too.
 */
export const appMcpEndpoints = sqliteTable('app_mcp_endpoints', {
  connectionId: text('connection_id').primaryKey().notNull(),
  endpoint: text('endpoint').notNull(),
  boundAt: integer('bound_at').notNull(),
})

/**
 * Servers the owner added (mcp/servers.ts), beside the deployment's configured ones. Title, description and icon are
 * the server's own claims from its card or registry entry; `source` records where it was found.
 */
export const appMcpServers = sqliteTable('app_mcp_connections', {
  connectionId: text('connection_id').primaryKey().notNull(),
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
  connectionId: text('connection_id').primaryKey().notNull(),
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
  connectionId: text('connection_id').notNull(),
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
/**
 * What this agent spent on models per UTC day (`YYYY-MM-DD`): tokens, and thousandths of an estimated Token Plan
 * Credit, which the per-user budget counts (ADR 0026).
 */
export const appUsageDaily = sqliteTable('app_usage_daily', {
  day: text('day').primaryKey().notNull(),
  tokens: integer('tokens').notNull(),
  milliCredits: integer('milli_credits').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
})

/**
 * The conversations the owner can reach, keyed by stable chat id: main, threads and subagents, as a tree through
 * `parent_session` (the parent chat). `pi_session` resolves each chat to its current Pi conversation (nothing rebinds
 * a chat; `epoch` is kept, and a decision is fenced on it) and a helper's immutable `spawner_session` keeps its
 * original anchor. Pi owns their transcripts; this is only what Pi does not keep: identity, kind, title, where it came
 * from, and whether it is closed. The retired `archived_at` column stays in the table (migrations are additive) and is
 * no longer read.
 */
export const appConversations = sqliteTable('app_conversations', {
  chatId: text('session_id').primaryKey().notNull(),
  piSession: text('pi_session').unique(),
  epoch: integer('epoch').notNull().default(0),
  /** `primary`: Personal's Conversation (inbound lands here); `conversation`: another Topic's; null: a thread. */
  role: text('role', { enum: ['primary', 'conversation', 'persona'] }),
  spawnerSession: text('spawner_session'),
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
  /** The Topic it belongs to (ADR 0032): Personal unless it is, or descends from, another Topic's Conversation. */
  topicId: integer('topic_id').notNull().default(1),
  /** The owner's operation that started this Thread from a composer or a Move (ADR 0034): one Thread per operation. */
  originOp: text('origin_op').unique(),
})

/**
 * Move to thread (ADR 0034): one row per owner operation. A settled move forks the Thread `fork_session` (chat
 * `thread_chat`) from `source_session` at `cut_entry`, the last entry of the turn the owner's message `message_entry`
 * started, and omits that turn in the chat. `relays` holds the relays handed to the Thread, chosen once.
 */
export const appChatMoves = sqliteTable('app_chat_moves', {
  operationId: text('operation_id').primaryKey().notNull(),
  chatId: text('chat_id').notNull(),
  threadChat: text('thread_chat'),
  sourceSession: text('source_session'),
  forkSession: text('fork_session'),
  messageEntry: integer('message_entry').notNull(),
  cutEntry: integer('cut_entry'),
  // Nothing writes `swap` or `swapped`, but an agent that ran the running-turn swap may hold such rows: reads see them.
  mode: text('mode', { enum: ['swap', 'settled'] }).notNull(),
  state: text('state', { enum: ['requested', 'forked', 'swapped', 'settled', 'refused'] }).notNull(),
  reason: text('reason'),
  relays: text('relays'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

/**
 * What a spawner switched off for its subagent (ADR 0018), in the table ADR 0010's per-conversation switches used: one
 * row per thing off. Only subagents have rows since ADR 0040. `connection_id` is empty for `subagents`; `name` is set only
 * for a `tool`.
 */
export const appHelperExclusions = sqliteTable(
  'app_conversation_capabilities',
  {
    sessionId: text('session_id').notNull(),
    kind: text('kind', { enum: ['server', 'tool', 'skills', 'subagents'] }).notNull(),
    connectionId: text('connection_id').notNull().default(''),
    name: text('name').notNull().default(''),
    offAt: integer('off_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.kind, table.connectionId, table.name] })],
)

/** App execution excluded from a helper and every helper below it. */
export const appExecutionExclusions = sqliteTable(
  'app_execution_exclusions',
  { sessionId: text('session_id').notNull(), app: text('app').notNull(), offAt: integer('off_at').notNull() },
  (table) => [primaryKey({ columns: [table.sessionId, table.app] })],
)

/** The user's model pick (one row, id 1); none means the deployment default (`models.ts`). */
export const appModelChoice = sqliteTable('app_model_choice', {
  id: integer('id').primaryKey().notNull(),
  modelId: text('model_id').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

/** Servers the owner uses skills from (skills/store.ts). A skill is a procedure; only these servers' are followed. */
export const appSkillSources = sqliteTable('app_skill_sources', {
  connectionId: text('connection_id').primaryKey().notNull(),
  enabledAt: integer('enabled_at').notNull(),
})

/** The skill entry each conversation activated, kept as loaded: its manifest pins the bytes later reads must match. */
export const appSkillActivations = sqliteTable(
  'app_skill_activations',
  {
    sessionId: text('session_id').notNull(),
    connectionId: text('connection_id').notNull(),
    uri: text('uri').notNull(),
    entry: text('entry').notNull(),
    activatedAt: integer('activated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.connectionId, table.uri] })],
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
  connectionId: text('connection_id').notNull(),
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
  connectionId: text('connection_id').notNull(),
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
    connectionId: text('connection_id').notNull(),
    name: text('name').notNull(),
    argumentsJson: text('arguments_json').notNull(),
    grantedAt: integer('granted_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.name, t.argumentsJson] })],
)

/** Endpoint-bound finite leases. Secrets are ciphertext bound to server, subscription and purpose. */
export const appMcpEventSubscriptions = sqliteTable(
  'app_mcp_event_subscriptions',
  {
    id: text('id').primaryKey().notNull(),
    connectionId: text('connection_id').notNull(),
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
  (t) => [uniqueIndex('app_event_selector').on(t.connectionId, t.name, t.argumentsJson)],
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
  connectionId: text('connection_id').notNull(),
  inboxCursor: text('inbox_cursor').notNull(),
  enabledAt: integer('enabled_at').notNull(),
})

/** A newer invalidation cannot be cleared by an older listing response. */
export const appSkillCatalogState = sqliteTable('app_skill_catalog_state', {
  connectionId: text('connection_id').primaryKey().notNull(),
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
 * The powers an app asked for and what the owner said (ADR 0021): a host to fetch from, an MCP tool, another app,
 * model calls, notifications. A power is usable while approved and not revoked; it stays when a release stops asking.
 */
export const appAgentPowers = sqliteTable(
  'app_agent_powers',
  {
    app: text('app').notNull(),
    kind: text('kind', { enum: ['egress', 'tool', 'app', 'llm', 'notify'] }).notNull(),
    target: text('target').notNull(),
    requestedBy: text('requested_by').notNull(),
    approvedAt: integer('approved_at'),
    revokedAt: integer('revoked_at'),
  },
  (table) => [primaryKey({ columns: [table.app, table.kind, table.target] })],
)

/** What an app spent per UTC day: fetches, model tokens, notifications, job runs; its daily caps read it. */
export const appAgentUsage = sqliteTable(
  'app_agent_usage',
  {
    app: text('app').notNull(),
    day: text('day').notNull(),
    kind: text('kind', { enum: ['egress', 'tokens', 'notify', 'job'] }).notNull(),
    amount: integer('amount').notNull(),
  },
  (table) => [primaryKey({ columns: [table.app, table.day, table.kind] })],
)

/**
 * An agent app's schedules (ADR 0021), one per action its active release schedules: when it runs next, the native
 * schedule armed for that, how the last run went, the failures in a row, and whether it is paused (by the owner, or
 * after ten failures until a new release).
 */
export const appAgentJobs = sqliteTable(
  'app_agent_jobs',
  {
    app: text('app').notNull(),
    action: text('action').notNull(),
    every: text('every', { enum: ['15m', '30m', '1h', '3h', '6h', '12h', '1d'] }).notNull(),
    at: text('at'),
    input: text('input').notNull(),
    release: text('release').notNull(),
    nextAt: integer('next_at').notNull(),
    scheduleId: text('schedule_id'),
    lastAt: integer('last_at'),
    lastStatus: text('last_status', { enum: ['ok', 'failed', 'waiting', 'skipped'] }),
    lastError: text('last_error'),
    failures: integer('failures').notNull().default(0),
    paused: text('paused', { enum: ['owner', 'failures'] }),
  },
  (table) => [primaryKey({ columns: [table.app, table.action] })],
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
    chatId: text('chat_id'),
    callId: text('call_id'),
    entryId: integer('entry_id'),
    connectionId: text('connection_id'),
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

/**
 * goblin's run ledger (ADR 0024): what Pi does not keep about a turn, beside its record. Each row is a turn, a model
 * attempt, a tool call or another run event with its ids, timing, outcome and scalar attributes, never content. A row
 * still `started` when the object restarts becomes `interrupted`; rows older than 30 days go.
 */
export const appRunEvents = sqliteTable(
  'app_run_events',
  {
    id: text('id').primaryKey().notNull(),
    kind: text('kind').notNull(),
    status: text('status', { enum: ['started', 'ok', 'error', 'blocked', 'interrupted'] }).notNull(),
    conversationId: text('conversation_id'),
    operationId: text('operation_id'),
    taskId: text('task_id'),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    attributes: text('attributes').notNull(),
  },
  (table) => [
    index('app_run_events_operation').on(table.operationId),
    index('app_run_events_conversation').on(table.conversationId, table.startedAt),
    index('app_run_events_task').on(table.taskId, table.startedAt),
    index('app_run_events_status').on(table.status, table.startedAt),
    index('app_run_events_started').on(table.startedAt),
  ],
)
