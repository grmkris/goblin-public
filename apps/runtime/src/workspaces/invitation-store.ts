import { and, eq, exists, gt, inArray, lt, notExists, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Conflict } from '../http/errors.ts'
import { MemberPolicy } from '@purrable/contracts'
import { Schema } from 'effect'
import { authUsers } from '../billing/schema.ts'
import { admissions, invitations, members, workspaces } from './schema.ts'
import { databaseOperation } from './store.ts'

type Database = ReturnType<typeof drizzle>
const pending = (db: Database, proofHash: string, email: string, now: number) =>
  db
    .select({ id: invitations.id })
    .from(invitations)
    .innerJoin(admissions, eq(admissions.invitationId, invitations.id))
    .innerJoin(workspaces, eq(invitations.workspaceId, workspaces.id))
    .where(
      and(
        eq(admissions.proofHash, proofHash),
        eq(admissions.state, 'active'),
        gt(admissions.expiresAt, now),
        eq(invitations.state, 'pending'),
        gt(invitations.expiresAt, now),
        eq(invitations.email, email),
        eq(invitations.version, admissions.invitationVersion),
        eq(workspaces.state, 'active'),
      ),
    )

/** Each acceptance predicate is inside the native D1 transaction, including expiry and workspace state. */
export async function consumeInvitation(
  database: D1Database,
  proofHash: string,
  userId: string,
  email: string,
  id: string,
) {
  const db = drizzle(database)
  const now = Date.now()
  const memberId = `mem_${crypto.randomUUID()}`
  const acceptedMember = db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.invitationId, id), eq(members.userId, userId), eq(members.state, 'active')))
  await databaseOperation(() =>
    db.batch([
      acceptedMemberInsert(db, { memberId, proofHash, userId, email, id, now }),
      db
        .update(invitations)
        .set({
          state: 'accepted',
          acceptedUserId: userId,
          acceptedMemberId: sql`${acceptedMember}`,
          updatedAt: now,
          version: sql`${invitations.version} + 1`,
        })
        .where(and(eq(invitations.id, id), eq(invitations.state, 'pending'), exists(acceptedMember))),
      db
        .update(admissions)
        .set({ state: 'used' })
        .where(
          and(
            eq(admissions.proofHash, proofHash),
            exists(
              db
                .select({ id: invitations.id })
                .from(invitations)
                .where(
                  and(
                    eq(invitations.id, id),
                    eq(invitations.state, 'accepted'),
                    eq(invitations.acceptedUserId, userId),
                  ),
                ),
            ),
          ),
        ),
    ]),
  )
  return acceptedReceipt(db, id, userId)
}

async function acceptedReceipt(db: Database, id: string, userId: string) {
  const result = await databaseOperation(() => db.select().from(invitations).where(eq(invitations.id, id)).get())
  if (result?.state !== 'accepted' || result.acceptedUserId !== userId || result.acceptedMemberId === null)
    throw new Conflict({ reason: 'invitation unavailable' })
  return { accepted: true, memberId: result.acceptedMemberId }
}

function eligibleInvite(db: Database, invite: typeof invitations.$inferInsert, now: number) {
  return db
    .select({ id: workspaces.id })
    .from(workspaces)
    .innerJoin(members, eq(members.workspaceId, workspaces.id))
    .where(
      and(
        eq(workspaces.id, invite.workspaceId),
        eq(workspaces.ownerUserId, invite.inviterUserId),
        eq(workspaces.state, 'active'),
        eq(members.userId, invite.inviterUserId),
        eq(members.role, 'owner'),
        eq(members.state, 'active'),
        sql`(SELECT count(*) FROM ${invitations} WHERE ${invitations.workspaceId} = ${invite.workspaceId} AND ${invitations.state} = 'pending') < 16`,
        sql`(SELECT count(*) FROM ${members} WHERE ${members.workspaceId} = ${invite.workspaceId} AND ${members.state} = 'active' AND ${members.role} <> 'owner') + (SELECT count(*) FROM ${invitations} WHERE ${invitations.workspaceId} = ${invite.workspaceId} AND ${invitations.state} = 'pending') < 16`,
        sql`(SELECT count(*) FROM ${invitations} WHERE ${invitations.workspaceId} = ${invite.workspaceId} AND ${invitations.createdAt} > ${now - 3_600_000}) < 10`,
        notExists(
          db
            .select({ id: members.id })
            .from(members)
            .innerJoin(authUsers, eq(members.userId, authUsers.id))
            .where(
              and(
                eq(members.workspaceId, invite.workspaceId),
                eq(members.state, 'active'),
                eq(authUsers.email, invite.email),
              ),
            ),
        ),
      ),
    )
}

/** Quotas and ownership are checked by the INSERT SELECT, including races between invitations. */
export async function insertInvitation(database: D1Database, invite: typeof invitations.$inferInsert) {
  const db = drizzle(database)
  const now = Date.now()
  await databaseOperation(() =>
    db
      .update(invitations)
      .set({ state: 'expired', updatedAt: now })
      .where(
        and(
          eq(invitations.workspaceId, invite.workspaceId),
          eq(invitations.state, 'pending'),
          lt(invitations.expiresAt, now),
        ),
      )
      .run(),
  )
  const eligible = eligibleInvite(db, invite, now)
  await databaseOperation(() =>
    db
      .insert(invitations)
      .select(
        db
          .select({
            id: sql<string>`${invite.id}`.as('id'),
            workspaceId: workspaces.id,
            email: sql<string>`${invite.email}`.as('email'),
            role: sql<'member' | 'viewer'>`${invite.role}`.as('role'),
            policyJson: sql<string>`${invite.policyJson}`.as('policyJson'),
            secretHash: sql<string>`${invite.secretHash}`.as('secretHash'),
            codeHash: sql<string>`${invite.codeHash}`.as('codeHash'),
            inviterUserId: workspaces.ownerUserId,
            state: sql<'pending'>`'pending'`.as('state'),
            sendState: sql<'pending'>`'pending'`.as('sendState'),
            version: sql<number>`1`.as('version'),
            expiresAt: sql<number>`${invite.expiresAt}`.as('expiresAt'),
            acceptedUserId: sql<null>`NULL`.as('acceptedUserId'),
            acceptedMemberId: sql<null>`NULL`.as('acceptedMemberId'),
            operationId: sql<string>`${invite.operationId}`.as('operationId'),
            requestHash: sql<string>`${invite.requestHash}`.as('requestHash'),
            createdAt: sql<number>`${now}`.as('createdAt'),
            updatedAt: sql<number>`${now}`.as('updatedAt'),
            lastOperationId: sql<null>`NULL`.as('lastOperationId'),
          })
          .from(workspaces)
          .where(inArray(workspaces.id, eligible)),
      )
      .onConflictDoNothing()
      .run(),
  )
  const row = await databaseOperation(() =>
    db
      .select()
      .from(invitations)
      .where(and(eq(invitations.workspaceId, invite.workspaceId), eq(invitations.operationId, invite.operationId)))
      .get(),
  )
  if (row === undefined) throw new Conflict({ reason: 'invitation limit or pending invitation' })
  if (row.requestHash !== invite.requestHash) throw new Conflict({ reason: 'operation replay differs' })
  return row
}
export const invitationReceipt = (invite: typeof invitations.$inferSelect) => ({
  id: invite.id,
  email: invite.email,
  role: invite.role,
  version: invite.version,
  expiresAt: invite.expiresAt,
  state: invite.state,
  sendState: invite.sendState,
  policy: Schema.decodeUnknownSync(MemberPolicy)(JSON.parse(invite.policyJson)),
})

function acceptedMemberInsert(
  db: Database,
  input: { memberId: string; proofHash: string; userId: string; email: string; id: string; now: number },
) {
  const { memberId, proofHash, userId, email, id, now } = input
  return db
    .insert(members)
    .select(
      db
        .select({
          id: sql<string>`${memberId}`.as('id'),
          workspaceId: invitations.workspaceId,
          userId: sql<string>`${userId}`.as('userId'),
          role: invitations.role,
          state: sql<'active'>`'active'`.as('state'),
          policyJson: invitations.policyJson,
          version: sql<number>`1`.as('version'),
          invitationId: invitations.id,
          joinedAt: sql<number>`${now}`.as('joinedAt'),
          removedAt: sql<null>`NULL`.as('removedAt'),
          lastOperationId: sql<string>`${id}`.as('lastOperationId'),
        })
        .from(invitations)
        .where(and(eq(invitations.id, id), inArray(invitations.id, pending(db, proofHash, email, now)))),
    )
    .onConflictDoUpdate({
      target: [members.workspaceId, members.userId],
      set: {
        role: sql`excluded.role`,
        state: 'active',
        policyJson: sql`excluded.policy_json`,
        invitationId: id,
        joinedAt: now,
        removedAt: null,
        lastOperationId: id,
        version: sql`${members.version} + 1`,
      },
      where: sql`${members.state} = 'removed' AND ${members.role} <> 'owner'`,
    })
}
