import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const appRoutines = sqliteTable('app_routines', {
  id: text('id').primaryKey().notNull(),
  revision: integer('revision').notNull(),
  state: text('state', { enum: ['proposed', 'activating', 'active', 'paused', 'completed', 'archived'] }).notNull(),
  definitionJson: text('definition_json').notNull(),
  proposerUserId: text('proposer_user_id').notNull(),
  confirmedByUserId: text('confirmed_by_user_id'),
  confirmedAt: integer('confirmed_at'),
  scheduleId: text('schedule_id'),
  nextFireAt: integer('next_fire_at'),
  lastFireAt: integer('last_fire_at'),
  missedCount: integer('missed_count').notNull().default(0),
  pendingTrigger: text('pending_trigger'),
  suppressedCount: integer('suppressed_count').notNull().default(0),
  health: text('health'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  /** The Topic that owns it (ADR 0032): the one whose chat proposed it, else Personal. It reports there. */
  topicId: integer('topic_id').notNull().default(1),
})
export const appRoutineOperations = sqliteTable('app_routine_operations', {
  operationId: text('operation_id').primaryKey().notNull(),
  requestJson: text('request_json').notNull(),
  responseJson: text('response_json').notNull(),
  createdAt: integer('created_at').notNull(),
})
export const appRoutineRuns = sqliteTable(
  'app_routine_runs',
  {
    id: text('id').primaryKey().notNull(),
    routineId: text('routine_id').notNull(),
    revision: integer('revision').notNull(),
    operationId: text('operation_id').notNull(),
    source: text('source', { enum: ['manual', 'once', 'cron', 'event'] }).notNull(),
    firedAt: integer('fired_at').notNull(),
    eventId: text('event_id'),
    subscriptionId: text('subscription_id'),
    webhookId: text('webhook_id'),
    definitionJson: text('definition_json').notNull(),
    eventDataSealed: text('event_data_sealed'),
    sessionId: text('session_id'),
    admittedAt: integer('admitted_at').notNull(),
    deadlineAt: integer('deadline_at').notNull(),
    state: text('state', {
      enum: ['admitted', 'running', 'waiting_owner', 'completed', 'skipped', 'failed', 'stopped'],
    }).notNull(),
    outcome: text('outcome'),
    summary: text('summary'),
    reportRequestId: text('report_request_id').notNull(),
    reportAcceptedAt: integer('report_accepted_at'),
    notificationText: text('notification_text'),
    notificationState: text('notification_state').notNull().default('none'),
    notificationReceipt: text('notification_receipt'),
    notificationConnectionId: text('notification_connection_id'),
    notificationAttempts: integer('notification_attempts').notNull().default(0),
    notificationNextAt: integer('notification_next_at').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('app_routine_operation').on(t.operationId),
    uniqueIndex('app_routine_session').on(t.sessionId),
    index('app_routine_event_spacing').on(t.source, t.admittedAt),
  ],
)
export const appRoutineUsage = sqliteTable(
  'app_routine_usage',
  {
    runId: text('run_id').notNull(),
    sourceKey: text('source_key').notNull(),
    utcDay: text('utc_day').notNull(),
    tokens: integer('tokens').notNull(),
    committedAt: integer('committed_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.sourceKey] })],
)
export const appRoutineSettings = sqliteTable('app_routine_settings', {
  id: integer('id').primaryKey().notNull(),
  timezone: text('timezone').notNull(),
  maxActive: integer('max_active').notNull().default(20),
  maxRunning: integer('max_running').notNull().default(2),
})
export const appRoutineUsageProjection = sqliteTable(
  'app_routine_usage_projection',
  {
    runId: text('run_id').notNull(),
    model: text('model').notNull(),
    tokens: integer('tokens').notNull(),
    /** The bucket's cumulative cost so far, in thousandths of a Credit: the next delta is measured from it. */
    milliCredits: integer('milli_credits').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.runId, t.model] })],
)
export const appRoutineAnswers = sqliteTable(
  'app_routine_answers',
  {
    runId: text('run_id').notNull(),
    operationId: text('operation_id').notNull(),
    requestJson: text('request_json').notNull(),
    interactionId: text('interaction_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.operationId] })],
)
export const appSubmissionOrigins = sqliteTable(
  'app_submission_origins',
  {
    sessionId: text('session_id').notNull(),
    operationId: text('operation_id').notNull(),
    principalUserId: text('principal_user_id').notNull(),
    role: text('role').notNull(),
    source: text('source').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.operationId] })],
)
export const appInteractions = sqliteTable('app_interactions', {
  id: text('id').primaryKey().notNull(),
  sessionId: text('session_id').notNull(),
  runId: text('run_id'),
  callId: text('call_id').notNull(),
  requesterUserId: text('requester_user_id').notNull(),
  answererUserId: text('answerer_user_id').notNull(),
  intent: text('intent').notNull(),
  requestHash: text('request_hash').notNull(),
  state: text('state').notNull(),
  expiresAt: integer('expires_at').notNull(),
  decisionOperationId: text('decision_operation_id'),
})
