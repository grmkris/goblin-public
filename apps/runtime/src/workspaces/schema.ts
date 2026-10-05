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
  lastOperationId: text('last_operation_id'),
})
export const invitations = sqliteTable('app_workspace_invitations', {
  id: text('id').primaryKey().notNull(),
  workspaceId: text('workspace_id').notNull(),
  email: text('email').notNull(),
  role: text('role', { enum: ['member', 'viewer'] }).notNull(),
  policyJson: text('policy_json').notNull(),
  secretHash: text('secret_hash').notNull(),
  codeHash: text('code_hash').notNull(),
  inviterUserId: text('inviter_user_id').notNull(),
  state: text('state', { enum: ['pending', 'accepted', 'revoked', 'expired'] }).notNull(),
  sendState: text('send_state', { enum: ['pending', 'sent', 'failed'] }).notNull(),
  version: integer('version').notNull(),
  expiresAt: integer('expires_at').notNull(),
  acceptedUserId: text('accepted_user_id'),
  acceptedMemberId: text('accepted_member_id'),
  operationId: text('operation_id').notNull(),
  requestHash: text('request_hash').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  lastOperationId: text('last_operation_id'),
})
export const admissions = sqliteTable('app_invite_admissions', {
  proofHash: text('proof_hash').primaryKey().notNull(),
  invitationId: text('invitation_id').notNull(),
  invitationVersion: integer('invitation_version').notNull(),
  email: text('email').notNull(),
  state: text('state', { enum: ['active', 'used', 'revoked'] }).notNull(),
  expiresAt: integer('expires_at').notNull(),
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
export const rateLimits = sqliteTable('app_workspace_rate_limits', {
  key: text('key').primaryKey().notNull(),
  windowStart: integer('window_start').notNull(),
  attempts: integer('attempts').notNull(),
})
