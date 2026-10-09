import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Topics (ADR 0032): Personal (id 1, Conversation chat `1`) and the owner's other channels. Each has exactly one
 * Conversation (`chat_id`, an `app_conversations` row with role `primary` or `conversation`); its threads carry the
 * Topic in `app_conversations.topic_id`. An active name is unique, ignoring case (a partial index in the migration);
 * `revision` counts changes. `operation_id` makes a create idempotent.
 */
export const appTopics = sqliteTable('app_topics', {
  id: integer('id').primaryKey().notNull(),
  name: text('name').notNull(),
  chatId: text('chat_id').notNull().unique(),
  archivedAt: integer('archived_at'),
  searchExcluded: integer('search_excluded', { mode: 'boolean' }).notNull().default(false),
  revision: integer('revision').notNull().default(1),
  operationId: text('operation_id').unique(),
  createdBy: text('created_by', { enum: ['owner', 'agent', 'system'] }).notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})
