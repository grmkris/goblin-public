import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * First-run Start (ADR 0048): one row, written once the owner acts on it. `steps` is a JSON array of the steps the
 * owner went through that the agent cannot read from anywhere else (how goblin pays, more services, the kickoff).
 */
export const appOnboarding = sqliteTable('app_onboarding', {
  id: integer('id').primaryKey().notNull(),
  status: text('status').notNull(),
  steps: text('steps').notNull(),
  kickoffAt: integer('kickoff_at'),
  updatedAt: integer('updated_at').notNull(),
})
