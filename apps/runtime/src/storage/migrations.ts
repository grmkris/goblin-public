import { drizzle } from 'drizzle-orm/durable-sqlite'
import { migrate } from 'drizzle-orm/durable-sqlite/migrator'
import { assertApplicationTable } from './vendor.ts'

const MIGRATIONS = [
  {
    name: '0001_app_metadata',
    table: 'app_metadata',
    sql: 'CREATE TABLE IF NOT EXISTS app_metadata (id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)',
  },
] as const

/** Additive application schema only. Pi/Agents tables are never inspected as data or migrated. */
export function runApplicationMigrations(storage: DurableObjectStorage): void {
  for (const migration of MIGRATIONS) assertApplicationTable(migration.table)
  migrate(drizzle(storage), {
    migrations: { '20261004000000_initial': MIGRATIONS[0].sql },
  })
}
