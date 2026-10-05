import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const audit = sqliteTable('app_workspace_audit', {
  id: text('id').primaryKey().notNull(),
  workspaceId: text('workspace_id').notNull(),
  actorUserId: text('actor_user_id').notNull(),
  targetId: text('target_id').notNull(),
  action: text('action').notNull(),
  operationId: text('operation_id').notNull(),
  requestHash: text('request_hash').notNull(),
  createdAt: integer('created_at').notNull(),
})
