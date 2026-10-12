import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * The owner's spending rule for a paid tool of a first-class server (ADR 0044): jobs up to `perJobMicros` run without
 * asking, until the day's total would pass `dailyMicros`. Amounts in micro-dollars.
 */
export const appMcpSpendRules = sqliteTable(
  'app_mcp_spend_rules',
  {
    connectionId: text('connection_id').notNull(),
    tool: text('tool').notNull(),
    perJobMicros: integer('per_job_micros'),
    dailyMicros: integer('daily_micros'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.connectionId, table.tool] })],
)

/**
 * Every paid call goblin sent, by the held call it went out as (ADR 0044): its amount and UTC day, for the day's total.
 * `standing`: it ran under the owner's rule, without asking.
 */
export const appMcpSpend = sqliteTable(
  'app_mcp_spend',
  {
    approvalId: text('approval_id').primaryKey().notNull(),
    connectionId: text('connection_id').notNull(),
    tool: text('tool').notNull(),
    day: text('day').notNull(),
    micros: integer('micros').notNull(),
    standing: integer('standing', { mode: 'boolean' }).notNull(),
    at: integer('at').notNull(),
  },
  (table) => [index('app_mcp_spend_day').on(table.connectionId, table.tool, table.day)],
)
