import { drizzle } from 'drizzle-orm/durable-sqlite'
import { migrate } from 'drizzle-orm/durable-sqlite/migrator'
import { BASE_MIGRATIONS } from './migrations/base.ts'
import { CONVERSATION_MIGRATIONS } from './migrations/conversation.ts'
import { DECISION_MIGRATIONS } from './migrations/decisions.ts'
import { BREAK, type Migration } from './migrations/migration.ts'
import { Internal } from '../http/errors.ts'
import { assertApplicationTable } from './vendor.ts'

/** Every application migration, the area lists merged in key order. */
const MIGRATIONS: readonly Migration[] = [
  ...BASE_MIGRATIONS,
  ...CONVERSATION_MIGRATIONS,
  ...DECISION_MIGRATIONS,
].toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

/** The migration keys in the order they apply. */
export const migrationKeys = (): readonly string[] => MIGRATIONS.map((migration) => migration.key)

/**
 * The statements of the migrations in order, from the one after `after` (or the first) through `through` (or the
 * last): unit tests build the real schema in `node:sqlite` with them, and check a copy step on data seeded between two.
 */
export function migrationStatements(range: { readonly after?: string; readonly through?: string } = {}): string[] {
  const keys = MIGRATIONS.map((migration) => migration.key)
  const start = range.after === undefined ? 0 : keys.indexOf(range.after) + 1
  const end = range.through === undefined ? keys.length : keys.indexOf(range.through) + 1
  if (start === 0 && range.after !== undefined) throw new Internal({ reason: `Unknown migration ${range.after}` })
  if (end === 0) throw new Internal({ reason: `Unknown migration ${String(range.through)}` })
  return MIGRATIONS.slice(start, end).flatMap((migration) => migration.sql.split(BREAK))
}

export function runApplicationMigrations(storage: DurableObjectStorage): void {
  for (const migration of MIGRATIONS) for (const table of migration.tables) assertApplicationTable(table)
  migrate(drizzle(storage), {
    migrations: Object.fromEntries(MIGRATIONS.map((migration) => [migration.key, migration.sql])),
  })
}
