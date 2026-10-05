import { and, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { RuntimeEnv } from '../env.ts'
import { deleteAgentOf } from '../auth/account.ts'
import { members, workspaces } from './schema.ts'
import { databaseOperation, makeWorkspaceStore } from './store.ts'
import { queuedAccountInvalidations, retryMemberInvalidations } from './invalidation.ts'

export async function registerAccount(database: D1Database, userId: string, kind: 'ordinary' | 'invitation') {
  await makeWorkspaceStore(database).recordAccount(userId, kind, Date.now())
}

/** Commit revocation before destruction. A failed destruction leaves the workspace closed and retryable. */
export async function deleteAccountWorkspaces(
  env: { readonly AGENTS: Pick<RuntimeEnv['AGENTS'], 'getByName'> },
  database: D1Database,
  userId: string,
): Promise<void> {
  const db = drizzle(database)
  const owned = await makeWorkspaceStore(database).owned(userId)
  const now = Date.now()
  const revokeMemberships = db
    .update(members)
    .set({ state: 'removed', removedAt: now, version: sql`${members.version} + 1` })
    .where(and(eq(members.userId, userId), eq(members.state, 'active'), sql`${members.role} <> 'owner'`))
  if (owned === undefined) {
    await databaseOperation(() => db.batch([revokeMemberships, queuedAccountInvalidations(db, userId)]))
    await retryMemberInvalidations({ AUTH_DB: database, AGENTS: env.AGENTS })
    return
  }
  await databaseOperation(() =>
    db.batch([
      revokeMemberships,
      queuedAccountInvalidations(db, userId),
      db
        .update(workspaces)
        .set({
          state: 'deleting',
          deletionPhase: 'pending',
          updatedAt: now,
          accessVersion: sql`${workspaces.accessVersion} + 1`,
        })
        .where(and(eq(workspaces.id, owned.id), eq(workspaces.state, 'active'))),
    ]),
  )
  await retryMemberInvalidations({ AUTH_DB: database, AGENTS: env.AGENTS })
  if (owned.deletionPhase !== 'destroyed') await deleteAgentOf(env, owned.ownerUserId)
  await databaseOperation(() =>
    db
      .update(workspaces)
      .set({ state: 'deleted', deletionPhase: 'destroyed', updatedAt: Date.now() })
      .where(eq(workspaces.id, owned.id))
      .run(),
  )
}
