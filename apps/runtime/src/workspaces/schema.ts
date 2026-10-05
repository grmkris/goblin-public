import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const workspaces = sqliteTable('app_agent_workspaces', {
  id: text('id').primaryKey().notNull(),
  ownerUserId: text('owner_user_id').notNull(),
  name: text('name').notNull(),
  state: text('state', { enum: ['active', 'deleting', 'deleted'] }).notNull(),
  accessVersion: integer('access_version').notNull(),
  deletionPhase: text('deletion_phase', { enum: ['pending', 'destroyed'] }),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})
export const members = sqliteTable('app_workspace_members', {
  id: text('id').primaryKey().notNull(),
  workspaceId: text('workspace_id').notNull(),
  userId: text('user_id').notNull(),
  role: text('role', { enum: ['owner', 'member', 'viewer'] }).notNull(),
  state: text('state', { enum: ['active', 'removed'] }).notNull(),
  policyJson: text('policy_json').notNull(),
  version: integer('version').notNull(),
  invitationId: text('invitation_id'),
  joinedAt: integer('joined_at').notNull(),
  removedAt: integer('removed_at'),
})
export const selections = sqliteTable('app_workspace_sessions', {
  sessionId: text('session_id').primaryKey().notNull(),
  workspaceId: text('workspace_id').notNull(),
  context: text('context').notNull(),
  updatedAt: integer('updated_at').notNull(),
})
export const accountAdmissions = sqliteTable('app_account_admissions', {
  userId: text('user_id').primaryKey().notNull(),
  kind: text('kind', { enum: ['ordinary', 'invitation'] }).notNull(),
  createdAt: integer('created_at').notNull(),
})
