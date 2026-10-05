import { and, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { alias } from 'drizzle-orm/sqlite-core'
import { authUsers } from '../billing/schema.ts'
import { Internal } from '../http/errors.ts'
import { accountAdmissions, members, selections, workspaces } from './schema.ts'

/** Short auth D1 operations; no mail, provider call or Agent RPC runs in a database batch. */
export const databaseOperation = async <A>(read: () => PromiseLike<A>): Promise<A> => {
  try {
    return await read()
  } catch {
    throw new Internal({ reason: 'workspace storage unavailable' })
  }
}
const NONE = JSON.stringify({ servers: [], skills: [], mainHistory: 'all' })
type Database = ReturnType<typeof drizzle>
const requester = alias(authUsers, 'workspace_requester')
const ownedWorkspace = alias(workspaces, 'workspace_owned')

/** One live query binds admission, ownership, active memberships and selection to the authenticated user. */
async function accessSnapshot(db: Database, userId: string, sessionId?: string) {
  const rows = await databaseOperation(() =>
    db
      .select({
        kind: accountAdmissions.kind,
        ownedId: ownedWorkspace.id,
        workspace: workspaces,
        member: members,
        ownerName: authUsers.name,
        selection: selections,
      })
      .from(requester)
      .leftJoin(accountAdmissions, eq(accountAdmissions.userId, requester.id))
      .leftJoin(ownedWorkspace, eq(ownedWorkspace.ownerUserId, requester.id))
      .leftJoin(members, and(eq(members.userId, requester.id), eq(members.state, 'active')))
      .leftJoin(workspaces, and(eq(workspaces.id, members.workspaceId), eq(workspaces.state, 'active')))
      .leftJoin(authUsers, eq(authUsers.id, workspaces.ownerUserId))
      .leftJoin(selections, eq(selections.sessionId, sessionId ?? ''))
      .where(eq(requester.id, userId))
      .all(),
  )
  return {
    kind: rows[0]?.kind ?? undefined,
    ownedId: rows[0]?.ownedId ?? undefined,
    selection: rows[0]?.selection ?? undefined,
    rows: rows.flatMap((row) =>
      row.workspace !== null && row.member !== null && row.ownerName !== null
        ? [{ workspace: row.workspace, member: row.member, ownerName: row.ownerName }]
        : [],
    ),
  }
}

const workspaceReads = (db: Database) => ({
  snapshot: (userId: string, sessionId?: string) => accessSnapshot(db, userId, sessionId),
  owned: (userId: string) =>
    databaseOperation(() => db.select().from(workspaces).where(eq(workspaces.ownerUserId, userId)).get()),
  workspace: (id: string) => databaseOperation(() => db.select().from(workspaces).where(eq(workspaces.id, id)).get()),
  list: (userId: string) =>
    databaseOperation(() =>
      db
        .select({ workspace: workspaces, member: members, ownerName: authUsers.name })
        .from(members)
        .innerJoin(workspaces, eq(members.workspaceId, workspaces.id))
        .innerJoin(authUsers, eq(workspaces.ownerUserId, authUsers.id))
        .where(and(eq(members.userId, userId), eq(members.state, 'active'), eq(workspaces.state, 'active')))
        .all(),
    ),
  selection: (sessionId: string) =>
    databaseOperation(() => db.select().from(selections).where(eq(selections.sessionId, sessionId)).get()),
})

const provision = (db: Database, userId: string, id: string, now: number) =>
  databaseOperation(() =>
    db.batch([
      db
        .insert(workspaces)
        .select(
          db
            .select({
              id: sql<string>`${id}`.as('id'),
              ownerUserId: authUsers.id,
              name: sql<string>`substr(${authUsers.name}, 1, 80) || '''s agent'`.as('name'),
              state: sql<'active'>`'active'`.as('state'),
              accessVersion: sql<number>`1`.as('accessVersion'),
              deletionPhase: sql<null>`NULL`.as('deletionPhase'),
              createdAt: sql<number>`${now}`.as('createdAt'),
              updatedAt: sql<number>`${now}`.as('updatedAt'),
            })
            .from(authUsers)
            .innerJoin(accountAdmissions, eq(accountAdmissions.userId, authUsers.id))
            .where(and(eq(authUsers.id, userId), eq(accountAdmissions.kind, 'ordinary'))),
        )
        .onConflictDoNothing(),
      db
        .insert(members)
        .select(
          db
            .select({
              id: sql<string>`'own_' || ${workspaces.id}`.as('id'),
              workspaceId: workspaces.id,
              userId: workspaces.ownerUserId,
              role: sql<'owner'>`'owner'`.as('role'),
              state: sql<'active'>`'active'`.as('state'),
              policyJson: sql<string>`${NONE}`.as('policyJson'),
              version: sql<number>`1`.as('version'),
              invitationId: sql<null>`NULL`.as('invitationId'),
              joinedAt: workspaces.createdAt,
              removedAt: sql<null>`NULL`.as('removedAt'),
              lastOperationId: sql<null>`NULL`.as('lastOperationId'),
            })
            .from(workspaces)
            .where(and(eq(workspaces.ownerUserId, userId), eq(workspaces.state, 'active'))),
        )
        .onConflictDoNothing(),
    ]),
  )

const workspaceWrites = (db: Database) => ({
  recordAccount: (userId: string, kind: 'ordinary' | 'invitation', now: number) =>
    databaseOperation(() =>
      db.insert(accountAdmissions).values({ userId, kind, createdAt: now }).onConflictDoNothing().run(),
    ),
  account: (userId: string) =>
    databaseOperation(() => db.select().from(accountAdmissions).where(eq(accountAdmissions.userId, userId)).get()),
  provision: (userId: string, id: string, now: number) => provision(db, userId, id, now),
  select: (sessionId: string, workspaceId: string, expected: string | null, context: string, now: number) =>
    databaseOperation(() =>
      db
        .insert(selections)
        .values({ sessionId, workspaceId, context, updatedAt: now })
        .onConflictDoUpdate({
          target: selections.sessionId,
          set: { workspaceId, context, updatedAt: now },
          where: eq(selections.context, expected ?? ''),
        })
        .returning()
        .get(),
    ),
})

export const makeWorkspaceStore = (database: D1Database) => {
  const db = drizzle(database)
  return { ...workspaceReads(db), ...workspaceWrites(db) }
}
export type WorkspaceStore = ReturnType<typeof makeWorkspaceStore>
