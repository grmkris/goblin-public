import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Held MCP calls: immutable encrypted arguments and results, with an explicit dispatch intent. */
export const appMcpApprovals = sqliteTable('app_mcp_approvals', {
  id: text('id').primaryKey().notNull(),
  caller: text('caller', { enum: ['model', 'app', 'human'] }).notNull(),
  sessionId: text('session_id'),
  sourceCallId: text('source_call_id'),
  taskId: text('task_id'),
  connectionId: text('connection_id').notNull(),
  name: text('name').notNull(),
  endpoint: text('endpoint').notNull(),
  grantVersion: text('grant_version').notNull(),
  argumentsSealed: text('arguments_sealed').notNull(),
  argumentsHash: text('arguments_hash').notNull(),
  resultSealed: text('result_sealed'),
  state: text('state', {
    enum: ['pending', 'approved', 'dispatching', 'completed', 'refused', 'failed', 'uncertain', 'expired'],
  }).notNull(),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})
