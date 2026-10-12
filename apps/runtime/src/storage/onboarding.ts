import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * First-run Start (ADR 0048): one row, written once the owner acts on it. `status` is `done` or `skipped` once kept (the
 * owner said so, or Start was found complete) and `open` while it is derived from the servers. `steps` is a JSON array
 * of the steps the owner went through that the agent cannot read from anywhere else (welcome, services, the kickoff);
 * an id an older Start had is ignored.
 */
export const appOnboarding = sqliteTable('app_onboarding', {
  id: integer('id').primaryKey().notNull(),
  status: text('status').notNull(),
  steps: text('steps').notNull(),
  kickoffAt: integer('kickoff_at'),
  updatedAt: integer('updated_at').notNull(),
})

/**
 * A sign-in Start sent the owner to (ADR 0048), by connection: the step to come back to, and whether to allow the
 * server's recommended tools once it is connected. Taken by the sign-in's callback; an old one is ignored.
 */
export const appOnboardingConnects = sqliteTable('app_onboarding_connects', {
  connectionId: text('connection_id').primaryKey().notNull(),
  step: text('step').notNull(),
  recommend: integer('recommend').notNull(),
  createdAt: integer('created_at').notNull(),
})
