import { PRIMARY_CHAT } from '@goblin/contracts'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import * as Effect from 'effect/Effect'
import { bindEndpoints } from '../../src/mcp/endpoints.ts'
import { AddedServerStore } from '../../src/mcp/servers.ts'
import { AppMetadata } from '../../src/storage/metadata.ts'
import { runApplicationMigrations } from '../../src/storage/migrations.ts'
import { appMcpCredentials, appMcpEndpoints, appMcpGrants, appMcpOauthPending } from '../../src/storage/schema.ts'
import { listTables } from '../../src/storage/vendor.ts'
import { askResult, recentResult } from '../internal-client.ts'
import { type AgentFetch, callOwner } from '../owner-client.ts'
import { type ProbeEnv, type Probes, type ProbeStub, inAgent, inWorker } from './probe.ts'
import {
  branchMain,
  ownerCreate,
  ownerResult,
  ownerSend,
  ownerSnapshot,
  ownerUpdate,
  workspaceConversations,
} from './probe-reads.ts'

/**
 * The startup check, run in the agent's `onRequest` after its start: migrating again changes no table, every
 * application table was made by the constructor (`constructed`, before Pi opened), metadata stores, and main's snapshot
 * reads empty. A table made later answers an error response.
 */
export async function startupCheck(storage: DurableObjectStorage, constructed: readonly string[], api: AgentFetch) {
  const before = listTables(storage)
  runApplicationMigrations(storage)
  const after = listTables(storage)
  if (after.some(({ name }) => name.startsWith('app_') && !constructed.includes(name))) return Response.error()
  const metadata = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* AppMetadata
      yield* service.set('probe', 'stored-once')
      yield* service.set('probe', 'stored-updated')
      return yield* service.get('probe')
    }).pipe(Effect.provide(AppMetadata.layer(storage))),
  )
  return Response.json({ snapshot: await ownerSnapshot(api, PRIMARY_CHAT), before, after, metadata })
}

const notesAt = (endpoint: string) => [{ serverId: 'notes', endpoint }]

/** Endpoint binding on the real SQLite store: a re-pointed server loses its credentials, grants and pending state. */
function bindingProbe(storage: DurableObjectStorage) {
  runApplicationMigrations(storage)
  const db = drizzle(storage)
  const stored = () => ({
    credentials: db.select().from(appMcpCredentials).all().length,
    grants: db.select().from(appMcpGrants).all().length,
    pending: db.select().from(appMcpOauthPending).all().length,
  })
  const first = bindEndpoints(db, notesAt('https://a.test/mcp'), 1)
  db.insert(appMcpCredentials).values({ serverId: 'notes', status: 'connected', tokens: 'sealed', updatedAt: 1 }).run()
  db.insert(appMcpGrants).values({ serverId: 'notes', capability: 'tool', name: 'read', createdAt: 1 }).run()
  db.insert(appMcpOauthPending).values({ state: 's', serverId: 'notes', codeVerifier: 'v', createdAt: 1 }).run()
  const same = bindEndpoints(db, notesAt('https://a.test/mcp'), 2)
  const kept = stored()
  const moved = bindEndpoints(db, notesAt('https://b.test/mcp'), 3)
  const bound = db.select().from(appMcpEndpoints).all()
  // An added server, removed: its row, binding, credentials, grants and pending sign-ins all go.
  const added = new AddedServerStore(db)
  added.add({ serverId: 'extra', endpoint: 'https://extra.test/mcp', title: 'Extra' }, 4)
  db.insert(appMcpCredentials).values({ serverId: 'extra', status: 'connected', tokens: 'sealed', updatedAt: 4 }).run()
  db.insert(appMcpGrants).values({ serverId: 'extra', capability: 'tool', name: 'read', createdAt: 4 }).run()
  const listed = added.list().map((server) => server.serverId)
  added.remove('extra')
  const removed = {
    listed,
    left: added.list().length,
    after: stored(),
    bound: db.select().from(appMcpEndpoints).all().length,
  }
  return { first, same, kept, moved, after: stored(), bound, removed }
}

/** Before the agent's services start: an added server `notes` (never reached), its `read` and `write` granted. */
function seedNotes(storage: DurableObjectStorage) {
  runApplicationMigrations(storage)
  const db = drizzle(storage)
  new AddedServerStore(db).add({ serverId: 'notes', endpoint: 'https://notes.test/mcp', title: 'Notes' }, 1)
  for (const name of ['read', 'write'])
    db.insert(appMcpGrants).values({ serverId: 'notes', capability: 'tool', name, createdAt: 1 }).run()
  return { seeded: 'notes' }
}

/**
 * The owner's API through a real stub: resident authority renews, revocation is sticky, threads are gated, refusals
 * cross as the typed failures, and a revoked agent refuses an inbound client's ask.
 */
async function ownerApiSequence(agent: ProbeStub) {
  const first = await ownerResult(agent, (api) => api.resident.status())
  const revoked = await ownerResult(agent, (api) => api.resident.set({ payload: { enabled: false } }))
  const afterOwnerRequest = await ownerResult(agent, (api) => api.resident.status())
  const enabled = await ownerResult(agent, (api) => api.resident.set({ payload: { enabled: true } }))
  const servers = await ownerResult(agent, (api) => api.mcp.servers())
  const unknownServer = await ownerResult(agent, (api) =>
    api.mcp.setToolGrant({ payload: { serverId: 'missing', name: 'tool', allowed: true } }),
  )
  const unknownApp = await ownerResult(agent, (api) =>
    api.mcp.setAppGrant({ payload: { serverId: 'missing', uri: 'ui://missing/app.html', allowed: true } }),
  )
  const noConversation = await recentResult(agent, 5)
  const thread = await ownerCreate(agent, {})
  const threads = await workspaceConversations(agent)
  const badBranch = await branchMain(agent, 999_999)
  const unknownThread = await ownerSend(agent, '424242', 'hello', 'op-unknown-thread')
  const closed = thread.ok ? await ownerUpdate(agent, thread.value.id, { closed: true }) : thread
  const mainUntouchable = await ownerUpdate(agent, PRIMARY_CHAT, { title: 'renamed' })
  const usage = await ownerResult(agent, (api) => api.agent.usage())
  const model = await ownerResult(agent, (api) => api.agent.model())
  const unknownModel = await ownerResult(agent, (api) => api.agent.chooseModel({ payload: { model: 'not-offered' } }))
  await callOwner(agent, (api) => api.resident.set({ payload: { enabled: false } }))
  const askWhileRevoked = await askResult(agent, 'Test client', 'hello', 'op-1', 1000)
  return {
    first,
    revoked,
    afterOwnerRequest,
    enabled,
    servers,
    unknownServer,
    unknownApp,
    noConversation,
    threads,
    badBranch,
    unknownThread,
    closed,
    mainUntouchable,
    usage,
    model,
    unknownModel,
    askWhileRevoked,
  }
}

/** How many entries main's snapshot holds, through the startup check's route; -1 when it holds none. */
const entries = async (agent: ProbeStub): Promise<number> => {
  const body: { snapshot?: { entries?: unknown[] } } = await (await agent.fetch('https://agent/test/startup')).json()
  return body.snapshot?.entries?.length ?? -1
}

/** Account deletion's agent half: state before, what the caller of `deleteAgentData` sees, state after. */
async function destroySequence(namespace: ProbeEnv['AGENTS'], name: string) {
  const agent = namespace.getByName(name)
  await callOwner(agent, (api) => api.resident.set({ payload: { enabled: false } }))
  const submitted = await ownerSend(agent, PRIMARY_CHAT, 'remember this before deletion', 'destroy-op-1')
  const before = await entries(agent)
  let deleted: unknown
  try {
    deleted = await agent.deleteAgentData()
  } catch (cause) {
    // expected: the probe answers with what deleteAgentData threw, for the case to assert on
    deleted = { thrown: cause instanceof Error ? cause.message : 'unknown' }
  }
  const fresh = namespace.getByName(name)
  return {
    submitted,
    before,
    deleted,
    after: await entries(fresh),
    resident: await ownerResult(fresh, (api) => api.resident.status()),
  }
}

export const probes: Probes = {
  startup: inWorker(async ({ agent }) => (await agent.fetch('https://agent/test/startup')).json()),
  binding: inAgent(({ storage }) => bindingProbe(storage)),
  'seed-notes': inAgent(({ storage }) => seedNotes(storage)),
  'owner-api': inWorker(({ agent }) => ownerApiSequence(agent)),
  destroy: inWorker(({ env, name }) => destroySequence(env.AGENTS, name)),
  evict: inAgent(({ evict }) => {
    evict('probe eviction')
    return { evicted: true }
  }),
}
