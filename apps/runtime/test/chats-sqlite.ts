import { DatabaseSync } from 'node:sqlite'
import { drizzle } from 'drizzle-orm/node-sqlite'
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
