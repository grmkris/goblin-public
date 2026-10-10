import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { drizzle } from 'drizzle-orm/node-sqlite'
import * as Layer from 'effect/Layer'
import { DatabaseSync } from 'node:sqlite'
import { Db } from '../src/runtime/db.ts'
import { migrationStatements } from '../src/storage/migrations.ts'

/**
 * Real SQLite with the application migrations applied, for directory, Topic and memory unit tests; native integrations
 * separately exercise the Durable Object driver. `range` stops or resumes the migrations around seeded data.
 */
export function chatDatabase(range: Parameters<typeof migrationStatements>[0] = {}) {
  const sqlite = new DatabaseSync(':memory:')
  const migrate = (next: Parameters<typeof migrationStatements>[0]) => {
    for (const statement of migrationStatements(next)) sqlite.exec(statement)
  }
  migrate(range)
  const db = drizzle({ client: sqlite })
  return { db, sqlite, migrate, close: () => sqlite.close() }
}

/** A test's database, as `chatDatabase` makes it. */
export type ChatDatabase = ReturnType<typeof chatDatabase>['db']

/** `db` as the stores take it: the Durable Object's Drizzle database. */
export const durable = (db: ChatDatabase): DrizzleSqliteDODatabase =>
  // SAFETY: the stores use only Drizzle's synchronous query builder, which node:sqlite's driver serves alike.
  db as never

/** The agent's database (`Db`) over `db`. */
export const sqliteDb = (db: ChatDatabase): Layer.Layer<Db> => Layer.succeed(Db, durable(db))
