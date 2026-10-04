import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Pi owns conversations; this table stores only application metadata. */
export const appMetadata = sqliteTable('app_metadata', {
  id: text('id').primaryKey().notNull(),
  value: text('value').notNull(),
})
