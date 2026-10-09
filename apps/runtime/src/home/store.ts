import { EMPTY_HOME, HomeLayout } from '@goblin/contracts'
import { eq } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import * as Schema from 'effect/Schema'
import { appHome } from '../storage/schema.ts'

/** The agent's synchronous SQLite, or a transaction on it. */
type HomeDb<RunResult> = Pick<SQLiteAsyncDatabase<'sync', RunResult>, 'select' | 'insert'>
export const readHome = <RunResult>(db: HomeDb<RunResult>): HomeLayout => {
  const row = db.select().from(appHome).where(eq(appHome.id, 1)).get()
  return row === undefined ? EMPTY_HOME : Schema.decodeUnknownSync(HomeLayout)(JSON.parse(row.layout))
}
export function writeHome<RunResult>(db: HomeDb<RunResult>, layout: HomeLayout): void {
  const valid = Schema.decodeSync(HomeLayout)(layout)
  const values = { id: 1, revision: valid.revision, layout: JSON.stringify(valid) }
  db.insert(appHome).values(values).onConflictDoUpdate({ target: appHome.id, set: values }).run()
}
/** Called inside the App erasure transaction, so deletion cannot leave a dangling tile. */
export function dropHomeApp<RunResult>(db: HomeDb<RunResult>, appId: string): void {
  const layout = readHome(db)
  const tiles = layout.tiles.filter((tile) => tile.kind !== 'app' || tile.appId !== appId)
  if (tiles.length !== layout.tiles.length) writeHome(db, { revision: layout.revision + 1, tiles })
}
