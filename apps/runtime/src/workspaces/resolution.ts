import type { WorkspaceState, WorkspaceView } from '@purrable/contracts'
import type { RuntimeEnv } from '../env.ts'
import { Conflict, Forbidden, NotFound } from '../http/errors.ts'
import type { UserSession } from '../auth/service.ts'
import { makeWorkspaceStore, type WorkspaceStore } from './store.ts'
type Snapshot = Awaited<ReturnType<WorkspaceStore['snapshot']>>

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
async function provisionPersonalWorkspace(store: WorkspaceStore, userId: string, snapshot: Snapshot): Promise<boolean> {
  if (snapshot.ownedId !== undefined || snapshot.kind !== 'ordinary') return false
  await store.provision(userId, `ws_${crypto.randomUUID()}`, Date.now())
  return true
}
async function loadSnapshot(store: WorkspaceStore, userId: string, sessionId?: string): Promise<Snapshot> {
  let snapshot = await store.snapshot(userId, sessionId)
  if (await provisionPersonalWorkspace(store, userId, snapshot)) snapshot = await store.snapshot(userId, sessionId)
  if (sessionId !== undefined && snapshot.selection === undefined) {
    const owned = snapshot.rows.find((row) => row.workspace.ownerUserId === userId && row.member.role === 'owner')
    if (owned !== undefined) {
      const selected = await store.select(sessionId, owned.workspace.id, null, crypto.randomUUID(), Date.now())
      snapshot = selected === undefined ? await store.snapshot(userId, sessionId) : { ...snapshot, selection: selected }
    }
  }
  return snapshot
}
export async function workspaceState(env: RuntimeEnv, session: UserSession): Promise<WorkspaceState> {
  const snapshot = await loadSnapshot(makeWorkspaceStore(env.AUTH_DB), session.userId, session.sessionId)
  const active = snapshot.rows.find((row) => row.workspace.id === snapshot.selection?.workspaceId)
  return {
    active: active === undefined ? null : view(active),
    context: snapshot.selection?.context ?? null,
    workspaces: snapshot.rows.map(view),
  }
}
export async function selectWorkspace(
  env: RuntimeEnv,
  session: UserSession,
  workspaceId: string,
  expected: string | null,
): Promise<WorkspaceState> {
  const store = makeWorkspaceStore(env.AUTH_DB)
  const snapshot = await store.snapshot(session.userId, session.sessionId)
  if (!snapshot.rows.some((row) => row.workspace.id === workspaceId)) throw new NotFound({ what: 'workspace' })
  if ((snapshot.selection?.context ?? null) !== expected) throw new Conflict({ reason: 'workspace context changed' })
  const selection = await store.select(session.sessionId, workspaceId, expected, crypto.randomUUID(), Date.now())
  if (selection === undefined) throw new Conflict({ reason: 'workspace context changed' })
  return workspaceState(env, session)
}

/** Derive the Agent name from verified D1 ownership. No request parameter supplies an Agent name. */
export async function ownerWorkspace(env: RuntimeEnv, userId: string) {
  const store = makeWorkspaceStore(env.AUTH_DB)
  const snapshot = await loadSnapshot(store, userId)
  const owned = snapshot.rows.find((row) => row.workspace.ownerUserId === userId && row.member.role === 'owner')
  if (owned === undefined) throw new NotFound({ what: 'workspace' })
  return owned.workspace
}
export async function sessionWorkspace(env: RuntimeEnv, session: UserSession, context?: string) {
  const snapshot = await loadSnapshot(makeWorkspaceStore(env.AUTH_DB), session.userId, session.sessionId)
  const row = snapshot.rows.find((item) => item.workspace.id === snapshot.selection?.workspaceId)
  if (row === undefined) throw new NotFound({ what: 'workspace' })
  const current = snapshot.selection?.context ?? null
  if (context !== undefined && context !== current) throw new Conflict({ reason: 'workspace context changed' })
  return { ...row, context: current, view: view(row) }
}
export async function sessionOwnerWorkspace(env: RuntimeEnv, session: UserSession, context?: string) {
  const principal = await sessionWorkspace(env, session, context)
  if (principal.member.role !== 'owner' || principal.workspace.ownerUserId !== session.userId)
    throw new Forbidden({ reason: 'shared agent access pending' })
  return principal.workspace
}
