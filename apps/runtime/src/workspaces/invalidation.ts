import { and, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { RuntimeEnv } from '../env.ts'
import { unwrap } from '../http/rpc.ts'
import { members, workspaces } from './schema.ts'
import { databaseOperation, makeWorkspaceStore } from './store.ts'

export const invalidations = sqliteTable('app_member_invalidations', {
  id: text('id').primaryKey().notNull(),
  owner: text('owner_user_id').notNull(),
  member: text('member_id').notNull(),
  version: integer('member_version').notNull(),
  state: text('state').notNull().default('pending'),
})

/** The same D1 batch as revocation queues a retained, versioned invalidation receipt. */
export function queuedInvalidation(db: ReturnType<typeof drizzle>, owner: string, id: string, operationId: string) {
  return db
    .insert(invalidations)
    .select(
      db
        .select({
          id: sql<string>`${`${id}:${operationId}`}`.as('id'),
          owner: sql<string>`${owner}`.as('owner'),
          member: members.id,
          version: members.version,
          state: sql<string>`'pending'`.as('state'),
        })
        .from(members)
        .where(and(eq(members.id, id), eq(members.lastOperationId, operationId))),
    )
    .onConflictDoNothing()
}

export function queuedAccountInvalidations(db: ReturnType<typeof drizzle>, userId: string) {
  return db
    .insert(invalidations)
    .select(
      db
        .select({
          id: sql<string>`${members.id} || ':' || ${members.version}`.as('id'),
          owner: workspaces.ownerUserId,
          member: members.id,
          version: members.version,
          state: sql<string>`'pending'`.as('state'),
        })
        .from(members)
        .innerJoin(workspaces, eq(workspaces.id, members.workspaceId))
        .where(and(eq(members.userId, userId), eq(members.state, 'removed'), sql`${members.role} <> 'owner'`)),
    )
    .onConflictDoNothing()
}

/** Live dispatch checks fence the gap; failed aborts stay pending for mutation retries and the hourly cron. */
export async function retryMemberInvalidations(env: {
  AUTH_DB: D1Database
  AGENTS: Pick<RuntimeEnv['AGENTS'], 'getByName'>
}): Promise<void> {
  const db = drizzle(env.AUTH_DB)
  const rows = await databaseOperation(() =>
    db.select().from(invalidations).where(eq(invalidations.state, 'pending')).limit(100).all(),
  )
  for (const row of rows) {
    try {
      // Destruction is final: a pending invalidation must never recreate a deleted owner's Agent.
      const workspace = await makeWorkspaceStore(env.AUTH_DB).owned(row.owner)
      if (workspace?.state === 'active') unwrap(await env.AGENTS.getByName(row.owner).memberInvalidate(row.member))
      await databaseOperation(() =>
        db.update(invalidations).set({ state: 'done' }).where(eq(invalidations.id, row.id)).run(),
      )
    } catch {
      continue
    }
  }
}
