import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * How goblin pays for the owner's model calls (one row, id 1; ADR 0047): the pay mode and the paid route. None means
 * the default, Credits first and then the wallet (`pay-mode.ts`).
 */
export const appPayMode = sqliteTable('app_pay_mode', {
  id: integer('id').primaryKey().notNull(),
  mode: text('mode', { enum: ['credits-then-wallet', 'credits', 'wallet'] }).notNull(),
  route: text('route', { enum: ['goblin', 'tempo'] }).notNull(),
  updatedAt: integer('updated_at').notNull(),
})
