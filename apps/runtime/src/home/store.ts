import { EMPTY_HOME, HomeLayout } from '@goblin/contracts'
import { eq } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import * as Schema from 'effect/Schema'
import { appHome } from '../storage/schema.ts'

/** The agent's synchronous SQLite, or a transaction on it. */
type HomeDb<RunResult> = Pick<SQLiteAsyncDatabase<'sync', RunResult>, 'select' | 'insert'>

/** A layout checked against its bounds (tile count, sizes, note length): what is stored, read back or made by edits. */
export const homeLayout: (layout: unknown) => HomeLayout = Schema.decodeUnknownSync(HomeLayout)

export const readHome = <RunResult>(db: HomeDb<RunResult>): HomeLayout => {
  const row = db.select().from(appHome).where(eq(appHome.id, 1)).get()
  return row === undefined ? EMPTY_HOME : homeLayout(JSON.parse(row.layout))
}
export function writeHome<RunResult>(db: HomeDb<RunResult>, layout: HomeLayout): void {
  const valid = homeLayout(layout)
  const values = { id: 1, revision: valid.revision, layout: JSON.stringify(valid) }
  db.insert(appHome).values(values).onConflictDoUpdate({ target: appHome.id, set: values }).run()
}
/** Called inside the App erasure transaction, so deletion cannot leave a dangling tile. */
export function dropHomeApp<RunResult>(db: HomeDb<RunResult>, appId: string): void {
  const layout = readHome(db)
  const tiles = layout.tiles.filter((tile) => tile.kind !== 'app' || tile.appId !== appId)
  if (tiles.length !== layout.tiles.length) writeHome(db, { revision: layout.revision + 1, tiles })
}
