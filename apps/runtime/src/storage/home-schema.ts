import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** The owner's one Home layout, separate from Pi and from the state of every app. */
export const appHome = sqliteTable('app_home', {
  id: integer('id').primaryKey().notNull(),
  revision: integer('revision').notNull(),
  layout: text('layout').notNull(),
})
/** Durable replay and Undo receipts; content belongs to application storage, never telemetry. */
export const appHomeOperations = sqliteTable('app_home_operations', {
  operationId: text('operation_id').primaryKey().notNull(),
  actor: text('actor', { enum: ['owner', 'agent'] }).notNull(),
  result: text('result').notNull(),
  before: text('before').notNull(),
})
