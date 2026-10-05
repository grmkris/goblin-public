import * as Schema from 'effect/Schema'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { RuntimeEnv } from '../env.ts'
import type { UserSession } from '../auth/service.ts'
import { requireAccountPlan } from '../billing/gates.ts'
import { authUsers } from '../billing/schema.ts'
import { readJson } from '../http/body.ts'
import { Conflict, Forbidden, NotFound } from '../http/errors.ts'
import { MemberPolicy, type MembersState } from '@purrable/contracts'
import { admissions, invitations, members, workspaces } from './schema.ts'
import { databaseOperation } from './store.ts'
import { sessionWorkspace } from './resolution.ts'
import { admissionCookie, hash, limitProof, readAdmission, secret } from './proof.ts'
import { consumeInvitation, insertInvitation, invitationReceipt } from './invitation-store.ts'
import { freezePolicy } from './policy.ts'
import { sendInvitation } from './send.ts'
import { changeInvitation, changeMember } from './management.ts'

const Create = Schema.Struct({
  operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  email: Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(320)),
  role: Schema.Literals(['member', 'viewer']),
  policy: MemberPolicy,
})
const Proof = Schema.Struct({
  proof: Schema.String.check(Schema.isMinLength(20), Schema.isMaxLength(64)),
})
const canonicalEmail = (email: string): string => email.trim().toLowerCase()
const policyJson = (policy: typeof MemberPolicy.Type): string => JSON.stringify(policy)
const parsePolicy = (value: string) => Schema.decodeUnknownSync(MemberPolicy)(JSON.parse(value))
const guardOrigin = (request: Request, appUrl: string): void => {
  if (request.headers.get('origin') !== new URL(appUrl).origin || request.headers.get('x-purrable-csrf') !== '1')
    throw new Forbidden({ reason: 'invitation write origin' })
}
function ownerGuard(row: { workspace: { ownerUserId: string }; member: { role: string } }, userId: string): void {
  if (row.workspace.ownerUserId !== userId || row.member.role !== 'owner')
    throw new Forbidden({ reason: 'owner required' })
}
async function roster(env: RuntimeEnv, session: UserSession, context: string | undefined): Promise<MembersState> {
  const principal = await sessionWorkspace(env, session, context)
  const isOwner = principal.member.role === 'owner' && principal.workspace.ownerUserId === session.userId
  await requireAccountPlan(env, session.userId)
  const db = drizzle(env.AUTH_DB)
  const rows = await databaseOperation(() =>
    db
      .select({ member: members, name: authUsers.name, email: authUsers.email })
      .from(members)
      .innerJoin(authUsers, eq(members.userId, authUsers.id))
      .where(
        and(eq(members.workspaceId, principal.workspace.id), isOwner ? undefined : eq(members.userId, session.userId)),
      )
      .all(),
  )
  const invites = isOwner
    ? await databaseOperation(() =>
        db.select().from(invitations).where(eq(invitations.workspaceId, principal.workspace.id)).all(),
      )
    : []
  return {
    workspace: principal.view,
    members: rows
      .filter((row) => row.member.state === 'active')
      .map((row) => ({
        id: row.member.id,
        userId: row.member.userId,
        name: row.name,
        email: row.email,
        role: row.member.role,
        version: row.member.version,
        policy: parsePolicy(row.member.policyJson),
      })),
    invitations: invites.map((invite) => ({
      id: invite.id,
      email: invite.email,
      role: invite.role,
      version: invite.version,
      expiresAt: invite.expiresAt,
      state: invite.state,
      sendState: invite.sendState,
      policy: parsePolicy(invite.policyJson),
    })),
  }
}

export async function createInvitation(env: RuntimeEnv, session: UserSession, request: Request): Promise<Response> {
  guardOrigin(request, env.APP_URL)
  const principal = await sessionWorkspace(env, session, request.headers.get('x-purrable-workspace') ?? undefined)
  ownerGuard(principal, session.userId)
  await requireAccountPlan(env, session.userId)
  const input = await readJson(request, Create)
  const email = canonicalEmail(input.email)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new Forbidden({ reason: 'invitation email' })
  const now = Date.now()
  const expiresAt = now + 7 * 86_400_000
  const fragment = secret()
  const code = secret(10).toUpperCase()
  const requestHash = await hash(JSON.stringify({ email, role: input.role, policy: input.policy }))
  const id = `inv_${secret(16)}`
  const db = drizzle(env.AUTH_DB)
  const existing = await databaseOperation(() =>
    db
      .select()
      .from(invitations)
      .where(and(eq(invitations.workspaceId, principal.workspace.id), eq(invitations.operationId, input.operationId)))
      .get(),
  )
  if (existing !== undefined) {
    if (existing.requestHash !== requestHash) throw new Conflict({ reason: 'operation replay differs' })
    return Response.json(invitationReceipt(existing))
  }
  const policy = await freezePolicy(env, principal.workspace.ownerUserId, input.policy)
  await limitProof(env.AUTH_DB, `sends:${principal.workspace.id}`, 10, 3_600_000)
  const secretHash = await hash(fragment)
  const codeHash = await hash(code)
  const persisted = await insertInvitation(env.AUTH_DB, {
    id,
    workspaceId: principal.workspace.id,
    email,
    role: input.role,
    policyJson: policyJson(policy),
    secretHash,
    codeHash,
    inviterUserId: session.userId,
    state: 'pending',
    sendState: 'pending',
    version: 1,
    expiresAt,
    operationId: input.operationId,
    requestHash,
    createdAt: now,
    updatedAt: now,
  })
  if (persisted.id !== id) return Response.json(invitationReceipt(persisted))
  const sendState = await sendInvitation(env, persisted, fragment, code)
  return Response.json(invitationReceipt({ ...persisted, sendState }))
}

export async function invitationPreview(env: RuntimeEnv, request: Request, id: string): Promise<Response> {
  guardOrigin(request, env.APP_URL)
  await limitProof(env.AUTH_DB, `preview-ip:${await hash(request.headers.get('cf-connecting-ip') ?? 'unknown')}`, 20)
  await limitProof(env.AUTH_DB, `preview:${id}`, 5)
  const input = await readJson(request, Proof)
  const db = drizzle(env.AUTH_DB)
  const invitationRow = await databaseOperation(() =>
    db
      .select({ invite: invitations, workspace: workspaces, ownerName: authUsers.name })
      .from(invitations)
      .innerJoin(workspaces, eq(invitations.workspaceId, workspaces.id))
      .innerJoin(authUsers, eq(workspaces.ownerUserId, authUsers.id))
      .where(and(eq(invitations.id, id), eq(workspaces.state, 'active')))
      .get(),
  )
  const invite = invitationRow?.invite
  if (invite === undefined || invite.state !== 'pending' || invite.expiresAt <= Date.now())
    throw new NotFound({ what: 'invitation' })
  const presentedHash = await hash(input.proof)
  if (presentedHash !== invite.secretHash && presentedHash !== invite.codeHash)
    throw new Forbidden({ reason: 'invitation proof' })
  const token = secret()
  const proofHash = await hash(token)
  await databaseOperation(() =>
    db
      .insert(admissions)
      .values({
        proofHash,
        invitationId: id,
        invitationVersion: invite.version,
        email: invite.email,
        state: 'active',
        expiresAt: Date.now() + 600_000,
      })
      .run(),
  )
  return new Response(
    JSON.stringify({
      id,
      workspaceName: invitationRow?.workspace.name ?? '',
      ownerName: invitationRow?.ownerName ?? '',
      role: invite.role,
      email: invite.email,
      expiresAt: invite.expiresAt,
    }),
    {
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'set-cookie': admissionCookie(token),
      },
    },
  )
}

export async function acceptInvitation(
  env: RuntimeEnv,
  session: UserSession,
  request: Request,
  id: string,
): Promise<Response> {
  guardOrigin(request, env.APP_URL)
  await requireAccountPlan(env, session.userId)
  if (!session.emailVerified || Date.now() - session.createdAt > 600_000)
    throw new Forbidden({ reason: 'fresh verified session required' })
  const row = await readAdmission(env.AUTH_DB, request.headers, session.email)
  if (row === undefined || row.invitation.id !== id) throw new Forbidden({ reason: 'invitation admission' })
  const receipt = await consumeInvitation(
    env.AUTH_DB,
    row.admission.proofHash,
    session.userId,
    canonicalEmail(session.email),
    id,
  )
  return Response.json(receipt, { headers: { 'set-cookie': admissionCookie('', 0), 'cache-control': 'no-store' } })
}

export async function membersApi(request: Request, env: RuntimeEnv, session: UserSession): Promise<Response> {
  const path = new URL(request.url).pathname
  const memberId = /^\/api\/members\/([\w-]{1,200})$/u.exec(path)?.[1]
  if (memberId !== undefined && (request.method === 'PATCH' || request.method === 'DELETE'))
    return changeMember(request, env, session, memberId, false)
  if (path === '/api/members/me/leave' && request.method === 'POST')
    return changeMember(request, env, session, '', true)
  const invitationChange = /^\/api\/invitations\/([\w-]{1,200})\/(resend|revoke)$/u.exec(path)
  if (invitationChange !== null && request.method === 'POST')
    return changeInvitation(request, env, session, invitationChange[1] ?? '', invitationChange[2] === 'resend')
  if (path === '/api/members' && request.method === 'GET')
    return Response.json(await roster(env, session, request.headers.get('x-purrable-workspace') ?? undefined))
  if (path === '/api/invitations' && request.method === 'POST') return createInvitation(env, session, request)
  const accept = /^\/api\/invitations\/([\w-]{1,200})\/accept$/u.exec(path)?.[1]
  if (accept !== undefined && request.method === 'POST') return acceptInvitation(env, session, request, accept)
  throw new NotFound({ what: 'members route' })
}

/** Resume a proved invitation after sign-in or checkout without putting its proof in a query or storage. */
export async function currentInvitation(env: RuntimeEnv, request: Request): Promise<Response> {
  const row = await readAdmission(env.AUTH_DB, request.headers)
  if (row === undefined) return Response.json(null)
  const db = drizzle(env.AUTH_DB)
  const owner = await databaseOperation(() =>
    db.select({ name: authUsers.name }).from(authUsers).where(eq(authUsers.id, row.workspace.ownerUserId)).get(),
  )
  return Response.json(
    {
      id: row.invitation.id,
      workspaceName: row.workspace.name,
      ownerName: owner?.name ?? '',
      email: row.invitation.email,
      role: row.invitation.role,
      expiresAt: row.invitation.expiresAt,
    },
    { headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } },
  )
}
