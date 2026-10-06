import { EMPTY_HOME, HomeLayout } from '@goblin/contracts'
import { eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Schema from 'effect/Schema'
import { appHome } from '../storage/schema.ts'

type HomeDb = Pick<DrizzleSqliteDODatabase, 'select' | 'insert'>
export const readHome = (db: HomeDb): HomeLayout => {
  const row = db.select().from(appHome).where(eq(appHome.id, 1)).get()
  return row === undefined ? EMPTY_HOME : Schema.decodeUnknownSync(HomeLayout)(JSON.parse(row.layout))
}
export function writeHome(db: HomeDb, layout: HomeLayout): void {
  const valid = Schema.decodeUnknownSync(HomeLayout)(layout)
  const values = { id: 1, revision: valid.revision, layout: JSON.stringify(valid) }
  db.insert(appHome).values(values).onConflictDoUpdate({ target: appHome.id, set: values }).run()
}
/** Called inside the App erasure transaction, so deletion cannot leave a dangling tile. */
export function dropHomeApp(db: HomeDb, appId: string): void {
  const layout = readHome(db)
  const tiles = layout.tiles.filter((tile) => tile.kind !== 'app' || tile.appId !== appId)
  if (tiles.length !== layout.tiles.length) writeHome(db, { revision: layout.revision + 1, tiles })
}
