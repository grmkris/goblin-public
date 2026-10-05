import { Schema } from 'effect'
import { and, eq, exists, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { MemberPolicy } from '@purrable/contracts'
import type { RuntimeEnv } from '../env.ts'
import type { UserSession } from '../auth/service.ts'
import { queuedInvalidation, retryMemberInvalidations } from './invalidation.ts'
import { readJson } from '../http/body.ts'
import { Conflict, Forbidden, InvalidInput, NotFound } from '../http/errors.ts'
import { requireAccountPlan } from '../billing/gates.ts'
import { requireWorkspaceWrite } from './routes.ts'
import { sessionWorkspace } from './resolution.ts'
import { admissions, invitations, members, selections, workspaces } from './schema.ts'
import { databaseOperation } from './store.ts'
import { audit } from './audit.ts'
import { hash, limitProof, secret } from './proof.ts'
import { freezePolicy } from './policy.ts'
import { sendInvitation } from './send.ts'

const Change = Schema.Struct({
  operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  role: Schema.optional(Schema.Literals(['member', 'viewer'])),
  policy: Schema.optional(MemberPolicy),
})
type Principal = Awaited<ReturnType<typeof sessionWorkspace>>
type Mutation = {
  principal: Principal
  session: UserSession
  input: typeof Change.Type
  id: string
  now: number
  requestHash: string
}
type Database = ReturnType<typeof drizzle>
const ownerAccess = (db: Database, workspaceId: string, userId: string) =>
  exists(
    db
      .select({ id: workspaces.id })
      .from(workspaces)
      .innerJoin(members, eq(members.workspaceId, workspaces.id))
      .where(
        and(
          eq(workspaces.id, workspaceId),
          eq(workspaces.state, 'active'),
          eq(workspaces.ownerUserId, userId),
          eq(members.userId, userId),
          eq(members.role, 'owner'),
          eq(members.state, 'active'),
        ),
      ),
  )
async function replay(db: Database, workspaceId: string, operationId: string, requestHash: string) {
  const receipt = await databaseOperation(() =>
    db
      .select()
      .from(audit)
      .where(and(eq(audit.workspaceId, workspaceId), eq(audit.operationId, operationId)))
      .get(),
  )
  if (receipt !== undefined && receipt.requestHash !== requestHash)
    throw new Conflict({ reason: 'operation replay differs' })
  return receipt
}

async function replayLeave(db: Database, session: UserSession, context: string | undefined, input: typeof Change.Type) {
  const selected = await databaseOperation(() =>
    db.select().from(selections).where(eq(selections.sessionId, session.sessionId)).get(),
  )
  if (context !== undefined && context !== selected?.context)
    throw new Conflict({ reason: 'workspace context changed' })
  if (selected === undefined) return false
  const receipt = await databaseOperation(() =>
    db
      .select({ id: members.id, requestHash: audit.requestHash })
      .from(audit)
      .innerJoin(members, eq(members.id, audit.targetId))
      .where(
        and(
          eq(audit.workspaceId, selected.workspaceId),
          eq(audit.actorUserId, session.userId),
          eq(audit.action, 'leave'),
          eq(audit.operationId, input.operationId),
          eq(members.userId, session.userId),
        ),
      )
      .get(),
  )
  if (receipt === undefined) return false
  if (receipt.requestHash !== (await hash(JSON.stringify({ action: 'leave', id: receipt.id, input }))))
    throw new Conflict({ reason: 'operation replay differs' })
  return true
}

function guardMemberChange(principal: Principal, session: UserSession, leave: boolean): void {
  if (!leave && (principal.member.role !== 'owner' || principal.workspace.ownerUserId !== session.userId))
    throw new Forbidden({ reason: 'owner required' })
  if (leave && principal.member.role === 'owner') throw new Forbidden({ reason: 'owner cannot leave' })
}

function memberChangeInput(input: typeof Change.Type, remove: boolean): void {
  if (remove && (input.policy !== undefined || input.role !== undefined))
    throw new InvalidInput({ reason: 'removal cannot change permissions' })
}

/** Receipt and mutation commit in one D1 batch; a losing CAS cannot create a success receipt. */
export async function changeMember(
  request: Request,
  env: RuntimeEnv,
  session: UserSession,
  targetId: string,
  leave: boolean,
) {
  requireWorkspaceWrite(request, env.APP_URL)
  const input = await readJson(request, Change)
  const remove = leave || request.method === 'DELETE'
  memberChangeInput(input, remove)
  const db = drizzle(env.AUTH_DB)
  const context = request.headers.get('x-purrable-workspace') ?? undefined
  if (leave && (await replayLeave(db, session, context, input))) {
    await retryMemberInvalidations(env)
    return Response.json({ ok: true })
  }
  const principal = await sessionWorkspace(env, session, context)
  guardMemberChange(principal, session, leave)
  if (!leave) await requireAccountPlan(env, session.userId)
  const id = leave ? principal.member.id : targetId
  const target = await databaseOperation(() =>
    db
      .select()
      .from(members)
      .where(and(eq(members.id, id), eq(members.workspaceId, principal.workspace.id)))
      .get(),
  )
  if (target === undefined || target.role === 'owner') throw new NotFound({ what: 'member' })
  const action = leave ? 'leave' : remove ? 'remove' : 'change'
  const requestHash = await hash(JSON.stringify({ action, id, input }))
  if (await replay(db, principal.workspace.id, input.operationId, requestHash)) {
    await retryMemberInvalidations(env)
    return Response.json({ ok: true })
  }
  const policy =
    input.policy === undefined ? undefined : await freezePolicy(env, principal.workspace.ownerUserId, input.policy)
  const now = Date.now()
  await memberBatch(db, { principal, session, input, id, now, requestHash, remove, leave, policy })
  if (!(await replay(db, principal.workspace.id, input.operationId, requestHash)))
    throw new Conflict({ reason: 'member version changed' })
  await retryMemberInvalidations(env)
  return Response.json({ ok: true })
}

async function memberBatch(
  db: Database,
  command: Mutation & { remove: boolean; leave: boolean; policy: typeof MemberPolicy.Type | undefined },
) {
  const { principal, session, input, id, now, requestHash, remove, leave, policy } = command
  const marker = db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.id, id), eq(members.lastOperationId, input.operationId)))
  await databaseOperation(() =>
    db.batch([
      db
        .update(members)
        .set({
          state: remove ? 'removed' : 'active',
          removedAt: remove ? now : null,
          ...(input.role === undefined ? {} : { role: input.role }),
          ...(policy === undefined ? {} : { policyJson: JSON.stringify(policy) }),
          version: sql`${members.version} + 1`,
          lastOperationId: input.operationId,
        })
        .where(
          and(
            eq(members.id, id),
            eq(members.state, 'active'),
            eq(members.version, input.version),
            leave
              ? exists(
                  db
                    .select({ id: workspaces.id })
                    .from(workspaces)
                    .where(and(eq(workspaces.id, principal.workspace.id), eq(workspaces.state, 'active'))),
                )
              : ownerAccess(db, principal.workspace.id, session.userId),
          ),
        ),
      db
        .insert(audit)
        .select(
          db
            .select({
              id: sql<string>`${crypto.randomUUID()}`.as('id'),
              workspaceId: members.workspaceId,
              actorUserId: sql<string>`${session.userId}`.as('actorUserId'),
              targetId: members.id,
              action: sql<string>`${leave ? 'leave' : remove ? 'remove' : 'change'}`.as('action'),
              operationId: sql<string>`${input.operationId}`.as('operationId'),
              requestHash: sql<string>`${requestHash}`.as('requestHash'),
              createdAt: sql<number>`${now}`.as('createdAt'),
            })
            .from(members)
            .where(inArray(members.id, marker)),
        )
        .onConflictDoNothing(),
      db
        .update(workspaces)
        .set({ accessVersion: sql`${workspaces.accessVersion} + 1`, updatedAt: now })
        .where(and(eq(workspaces.id, principal.workspace.id), exists(marker))),
      queuedInvalidation(db, principal.workspace.ownerUserId, id, input.operationId),
    ]),
  )
}

export async function changeInvitation(
  request: Request,
  env: RuntimeEnv,
  session: UserSession,
  id: string,
  resend: boolean,
) {
  requireWorkspaceWrite(request, env.APP_URL)
  const principal = await sessionWorkspace(env, session, request.headers.get('x-purrable-workspace') ?? undefined)
  if (principal.member.role !== 'owner' || principal.workspace.ownerUserId !== session.userId)
    throw new Forbidden({ reason: 'owner required' })
  await requireAccountPlan(env, session.userId)
  const input = await readJson(request, Change)
  const db = drizzle(env.AUTH_DB)
  const target = await databaseOperation(() =>
    db
      .select()
      .from(invitations)
      .where(and(eq(invitations.id, id), eq(invitations.workspaceId, principal.workspace.id)))
      .get(),
  )
  if (target === undefined) throw new NotFound({ what: 'invitation' })
  const requestHash = await hash(JSON.stringify({ action: resend ? 'resend' : 'revoke', id, input }))
  if (await replay(db, principal.workspace.id, input.operationId, requestHash)) return Response.json({ ok: true })
  if (resend) await limitProof(env.AUTH_DB, `sends:${principal.workspace.id}`, 10, 3_600_000)
  const fragment = secret()
  const code = secret(10).toUpperCase()
  const now = Date.now()
  const secretHash = await hash(fragment)
  const codeHash = await hash(code)
  await invitationBatch(db, { principal, session, input, id, now, requestHash, resend, secretHash, codeHash })
  if (!(await replay(db, principal.workspace.id, input.operationId, requestHash)))
    throw new Conflict({ reason: 'invitation version changed' })
  if (resend) await sendInvitation(env, { ...target, version: target.version + 1 }, fragment, code)
  return Response.json({ ok: true })
}

async function invitationBatch(
  db: Database,
  command: Mutation & { resend: boolean; secretHash: string; codeHash: string },
) {
  const { principal, session, input, id, now, requestHash, resend, secretHash, codeHash } = command
  const marker = db
    .select({ id: invitations.id })
    .from(invitations)
    .where(and(eq(invitations.id, id), eq(invitations.lastOperationId, input.operationId)))
  await databaseOperation(() =>
    db.batch([
      db
        .update(invitations)
        .set({
          state: resend ? 'pending' : 'revoked',
          version: sql`${invitations.version} + 1`,
          updatedAt: now,
          lastOperationId: input.operationId,
          ...(resend ? { secretHash, codeHash, expiresAt: now + 7 * 86_400_000, sendState: 'pending' as const } : {}),
        })
        .where(
          and(
            eq(invitations.id, id),
            eq(invitations.version, input.version),
            eq(invitations.state, 'pending'),
            ownerAccess(db, principal.workspace.id, session.userId),
          ),
        ),
      db
        .update(admissions)
        .set({ state: 'revoked' })
        .where(and(eq(admissions.invitationId, id), exists(marker))),
      db
        .insert(audit)
        .select(
          db
            .select({
              id: sql<string>`${crypto.randomUUID()}`.as('id'),
              workspaceId: invitations.workspaceId,
              actorUserId: sql<string>`${session.userId}`.as('actorUserId'),
              targetId: invitations.id,
              action: sql<string>`${resend ? 'resend' : 'revoke'}`.as('action'),
              operationId: sql<string>`${input.operationId}`.as('operationId'),
              requestHash: sql<string>`${requestHash}`.as('requestHash'),
              createdAt: sql<number>`${now}`.as('createdAt'),
            })
            .from(invitations)
            .where(inArray(invitations.id, marker)),
        )
        .onConflictDoNothing(),
    ]),
  )
}
