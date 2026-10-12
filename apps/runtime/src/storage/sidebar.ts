import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** The owner's one set of sidebar pins (ADR 0053): its revision and the pins as JSON, separate from Pi and from Apps. */
export const appSidebar = sqliteTable('app_sidebar', {
  id: integer('id').primaryKey().notNull(),
  revision: integer('revision').notNull(),
  pins: text('pins').notNull(),
})
