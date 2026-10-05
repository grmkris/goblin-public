import { and, eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { MemberPrincipal } from '../env.ts'
import { NotFound } from '../http/errors.ts'
import { makeWorkspaceStore } from '../workspaces/store.ts'
export const threadReaders = sqliteTable(
  'app_thread_readers',
  {
    session: text('session_id').notNull(),
    user: text('user_id').notNull(),
    by: text('granted_by_user_id').notNull(),
    at: integer('granted_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.session, t.user] })],
)
export function isReader(db: DrizzleSqliteDODatabase, session: string, user: string): boolean {
  return (
    db
      .select()
      .from(threadReaders)
      .where(and(eq(threadReaders.session, session), eq(threadReaders.user, user)))
      .get() !== undefined
  )
}
export async function setReaders(
  db: DrizzleSqliteDODatabase,
  env: import('../env.ts').RuntimeEnv,
  principal: MemberPrincipal,
  session: string,
  readers: readonly string[],
): Promise<void> {
  for (const user of readers) {
    const member = (await makeWorkspaceStore(env.AUTH_DB).list(user)).find(
      (r) => r.workspace.id === principal.workspaceId,
    )
    if (member === undefined) throw new NotFound({ what: 'reader membership' })
  }
  db.transaction(() => {
    db.delete(threadReaders).where(eq(threadReaders.session, session)).run()
    for (const user of readers)
      db.insert(threadReaders).values({ session, user, by: principal.userId, at: Date.now() }).run()
  })
}
