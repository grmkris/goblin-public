import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * URL requests (ADR 0042): a model's MCP call the server answered "input required: open this URL". The call's
 * arguments, the server's request state and its prompt (the link and message) are sealed; the owner finishes or
 * cancels it, and its retry's result is kept for the turn that asked.
 */
export const appMcpUrlRequests = sqliteTable('app_mcp_url_requests', {
  id: text('id').primaryKey().notNull(),
  sessionId: text('session_id').notNull(),
  sourceCallId: text('source_call_id').notNull(),
  taskId: text('task_id').notNull(),
  connectionId: text('connection_id').notNull(),
  name: text('name').notNull(),
  endpoint: text('endpoint').notNull(),
  argumentsSealed: text('arguments_sealed').notNull(),
  argumentsHash: text('arguments_hash').notNull(),
  /** The input request's key in the server's `inputRequests`, answered under the same key. */
  inputKey: text('input_key').notNull(),
  /** The server's `requestState`, sent back with the answer; absent when it gave none. */
  stateSealed: text('state_sealed'),
  /** The link and the server's message, as one sealed JSON object. */
  promptSealed: text('prompt_sealed').notNull(),
  resultSealed: text('result_sealed'),
  /**
   * The tool's input schema as the connection listed it when the server asked: the answer is sent with it even if the
   * server has dropped the tool since (finishing its step can). Absent when it was too large to keep.
   */
  toolSchema: text('tool_schema'),
  state: text('state', {
    enum: ['pending', 'retrying', 'completed', 'declined', 'expired', 'failed', 'uncertain'],
  }).notNull(),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})
