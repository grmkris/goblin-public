import type { WorkspaceState, WorkspaceView } from '@purrable/contracts'
import type { RuntimeEnv } from '../env.ts'
import { Conflict, Forbidden, NotFound } from '../http/errors.ts'
import type { UserSession } from '../auth/service.ts'
import { makeWorkspaceStore, type WorkspaceStore } from './store.ts'

const view = (row: Awaited<ReturnType<WorkspaceStore['list']>>[number]): WorkspaceView => ({
  id: row.workspace.id,
  name: row.workspace.name,
  ownerName: row.ownerName,
  role: row.member.role,
  memberId: row.member.id,
  memberVersion: row.member.version,
  accessVersion: row.workspace.accessVersion,
  // Member execution waits for verified provenance, capability scope and requester-owned budget integration.
  agentReady: row.member.role === 'owner' && row.workspace.ownerUserId === row.member.userId,
})

/** Only ordinary accounts get a personal workspace. Invitation-only accounts never fall back to their user id. */
export async function provisionPersonalWorkspace(store: WorkspaceStore, userId: string): Promise<void> {
  if ((await store.account(userId))?.kind === 'ordinary')
    await store.provision(userId, `ws_${crypto.randomUUID()}`, Date.now())
}
export async function workspaceState(env: RuntimeEnv, session: UserSession): Promise<WorkspaceState> {
  const store = makeWorkspaceStore(env.AUTH_DB)
  await provisionPersonalWorkspace(store, session.userId)
  const rows = await store.list(session.userId)
  let selection = await store.selection(session.sessionId)
  if (selection === undefined) {
    const owned = rows.find((row) => row.workspace.ownerUserId === session.userId)
    if (owned !== undefined) {
      await store.select(session.sessionId, owned.workspace.id, null, crypto.randomUUID(), Date.now())
      selection = await store.selection(session.sessionId)
    }
  }
  const active = rows.find((row) => row.workspace.id === selection?.workspaceId)
  return {
    active: active === undefined ? null : view(active),
    context: selection?.context ?? null,
    workspaces: rows.map(view),
  }
}
export async function selectWorkspace(
  env: RuntimeEnv,
  session: UserSession,
  workspaceId: string,
  expected: string | null,
): Promise<WorkspaceState> {
  const store = makeWorkspaceStore(env.AUTH_DB)
  const rows = await store.list(session.userId)
  if (!rows.some((row) => row.workspace.id === workspaceId)) throw new NotFound({ what: 'workspace' })
  if (((await store.selection(session.sessionId))?.context ?? null) !== expected)
    throw new Conflict({ reason: 'workspace context changed' })
  const selection = await store.select(session.sessionId, workspaceId, expected, crypto.randomUUID(), Date.now())
  if (selection === undefined) throw new Conflict({ reason: 'workspace context changed' })
  return workspaceState(env, session)
}

/** Derive the Agent name from verified D1 ownership. No request parameter supplies an Agent name. */
export async function ownerWorkspace(env: RuntimeEnv, userId: string) {
  const store = makeWorkspaceStore(env.AUTH_DB)
  await provisionPersonalWorkspace(store, userId)
  const rows = await store.list(userId)
  const owned = rows.find((row) => row.workspace.ownerUserId === userId && row.member.role === 'owner')
  if (owned === undefined) throw new NotFound({ what: 'workspace' })
  return owned.workspace
}
export async function sessionWorkspace(env: RuntimeEnv, session: UserSession, context?: string) {
  const state = await workspaceState(env, session)
  if (state.active === null) throw new NotFound({ what: 'workspace' })
  if (context !== undefined && context !== state.context) throw new Conflict({ reason: 'workspace context changed' })
  const store = makeWorkspaceStore(env.AUTH_DB)
  const row = (await store.list(session.userId)).find((item) => item.workspace.id === state.active?.id)
  if (row === undefined) throw new NotFound({ what: 'workspace' })
  return { ...row, context: state.context, view: state.active }
}
export async function sessionOwnerWorkspace(env: RuntimeEnv, session: UserSession, context?: string) {
  const principal = await sessionWorkspace(env, session, context)
  if (principal.member.role !== 'owner' || principal.workspace.ownerUserId !== session.userId)
    throw new Forbidden({ reason: 'shared agent access pending' })
  return principal.workspace
}
