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
    memberId: text('member_id'),
    memberVersion: integer('member_version'),
  },
  (t) => [primaryKey({ columns: [t.session, t.user] })],
)
export function isReader(db: DrizzleSqliteDODatabase, session: string, principal: MemberPrincipal): boolean {
  return (
    db
      .select()
      .from(threadReaders)
      .where(
        and(
          eq(threadReaders.session, session),
          eq(threadReaders.user, principal.userId),
          eq(threadReaders.memberId, principal.memberId),
          eq(threadReaders.memberVersion, principal.memberVersion),
        ),
      )
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
  const selected: { user: string; memberId: string; memberVersion: number }[] = []
  for (const user of new Set(readers)) {
    const member = (await makeWorkspaceStore(env.AUTH_DB).list(user)).find(
      (r) => r.workspace.id === principal.workspaceId,
    )
    if (member === undefined) throw new NotFound({ what: 'reader membership' })
    selected.push({ user, memberId: member.member.id, memberVersion: member.member.version })
  }
  db.transaction(() => {
    db.delete(threadReaders).where(eq(threadReaders.session, session)).run()
    for (const reader of selected)
      db.insert(threadReaders)
        .values({ session, ...reader, by: principal.userId, at: Date.now() })
        .run()
  })
}
