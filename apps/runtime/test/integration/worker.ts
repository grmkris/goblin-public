import type { EntitlementPolicy } from '../../src/billing/gates.ts'
import { canonicalRedirect } from '../../src/http/canonical.ts'
import { inboundHostProbe } from './inbound-host.ts'
import { type ConversationView, PRIMARY_CHAT } from '@goblin/contracts'
import { eventsProbe } from './events-probe.ts'
import { routinesProbe } from './routines-probe.ts'
import { routineExecutionProbe } from './routines-execution.ts'
import { routineQuestionProbe, routineStopProbe, routineRecoveryWrite, routineRecoveryRead } from './routines-safety.ts'
import { routineScheduleProbe } from './routines-scheduling.ts'
import { routineUsageProbe } from './routines-usage.ts'
import { routineNotificationProbe } from './routines-notifications.ts'
import { routineEventsProbe } from './routines-events.ts'
import { ownerResult } from './routines-owner.ts'
import { EventsFixture } from '../mcp/events-fixture.ts'
import { PersonalAgent } from '../../src/agent.ts'
import { runApplicationMigrations } from '../../src/storage/migrations.ts'
import { listTables } from '../../src/storage/vendor.ts'
import * as Effect from 'effect/Effect'
import { AppMetadata } from '../../src/storage/metadata.ts'
import { Agent } from 'agents'
import { PiHarness } from 'agents/harness/pi'
import { createRegistry, defineTool, Harness } from '@earendil-works/pi-durable'
import { type ProviderStreams, Type } from '@earendil-works/pi-ai'
import { FIXTURE_INPUT, type SeenRequest, fixtureModels, model, scriptedStreams } from './model.ts'
import { nextInt } from 'effect/Random'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import { bindEndpoints } from '../../src/mcp/endpoints.ts'
import { AddedServerStore } from '../../src/mcp/servers.ts'
import {
  appConversations,
  appMcpCredentials,
  appMcpEndpoints,
  appMcpGrants,
  appMcpOauthPending,
} from '../../src/storage/schema.ts'
import { CapabilityProfiles } from '../../src/capabilities/profiles.ts'
import { permutePrimary, profileEnabled } from './primary-profile.ts'
import { ChatDirectory } from '../../src/chats/directory.ts'
import { unwrap } from '../../src/http/rpc.ts'
import { skillsCacheProbe, skillsLearnerRejectionProbe, skillsPersistedRead } from './skills-probe.ts'
import { callOwner } from './owner-api.ts'
import { exchange, historyOf, linesOf, snapshotOf, threadsUntil, transcript, until } from './probe-reads.ts'
import {
  subagentChainSequence,
  subagentCloseSequence,
  subagentOwnerSequence,
  subagentSynthesisSequence,
} from './subagent-probe.ts'
import { filesSequence, filesStoreProbe } from './files-probe.ts'
import { appsEngineProbe, appsPowersProbe, appsTurnProbe } from './apps-probe.ts'
import { appsJobsProbe } from './apps-jobs-probe.ts'
import { telemetryProbe } from './telemetry-probe.ts'
import { JOB_CALLBACK, type JobSchedules } from '../../src/agent-apps/jobs.ts'
import { homeProbe, retainedHome } from './home-probe.ts'
import { inboxAppProbe } from './inbox-app-probe.ts'
import { FileStore } from '../../src/files/store.ts'
import { composerSequence, helperExclusionsProbe } from './composer-probe.ts'
import { topicMemorySequence, topicRoutineSequence } from './native-topics.ts'
import { callOwner } from './owner-api.ts'
import { ownerResult } from './owner-result.ts'
import { ResidentAuthority } from '../../src/resident.ts'

const fixturePlan = () =>
  Effect.succeed({
    active: true,
    source: 'override' as const,
    until: null,
    dailyCredits: 300_000,
    status: 'fixture',
    hasCustomer: false,
    cancelAtPeriodEnd: false,
  })

const notesAt = (endpoint: string) => [{ serverId: 'notes', endpoint }]

/** The actual PersonalAgent on a scripted model (no network): every request it makes is kept for the test to read. */
export class PersonalAgentProbe extends PersonalAgent {
  readonly seen: SeenRequest[] = []
  readonly instance = String(Effect.runSync(nextInt))
  readonly routineProducer = new EventsFixture()

  modelRequestCount(): number {
    return this.seen.length
  }
  helperExclusionsProbe() {
    return helperExclusionsProbe(this.ctx.storage)
  }

  override async onStart(): Promise<void> {
    await super.onStart()
    if (profileEnabled(this.env)) await permutePrimary(this.ctx.storage, this.harness)
  }

  protected override entitlementPolicy(): EntitlementPolicy {
    return { state: fixturePlan, require: fixturePlan }
  }

  async primaryProfileProbe() {
    const operationId = 'permuted-primary-proof'
    await this.submit(PRIMARY_CHAT, 'prove the primary binding', operationId)
    const settled = await this.settle(PRIMARY_CHAT, operationId)
    const directory = new ChatDirectory(drizzle(this.ctx.storage))
    const session = directory.session(PRIMARY_CHAT)
    const inbound = unwrap(await this.askAsClient('fixture-client', 'inbound binding proof', 'primary-inbound', 5000))
    const recent = unwrap(await this.recentMessages(20))
    return {
      session,
      inboundStatus: inbound.status,
      inboundSession: directory.operation(PRIMARY_CHAT, 'primary-inbound'),
      recentInbound: recent.some(
        (message) => message.author === 'fixture-client' && message.text === 'inbound binding proof',
      ),
      settledSession: settled.session,
      rootMessages: (await this.harness.messages({ session: '1' })).length,
      primaryMessages: (await this.harness.messages({ session })).length,
    }
  }

  eventsProbe() {
    return eventsProbe(this.ctx.storage, this.harness)
  }

  routinesProbe() {
    return routinesProbe(this.ctx.storage)
  }
  async homeProbe(): Promise<string> {
    return JSON.stringify(await homeProbe(this.ctx.storage, this.env, this.name, this.harness))
  }
  async inboxAppProbe(): Promise<string> {
    return JSON.stringify(await inboxAppProbe(this.ctx.storage, this.env, this.name, this.harness))
  }
  async homeRetained(): Promise<string> {
    return JSON.stringify(retainedHome(this.ctx.storage))
  }

  filesStoreProbe() {
    return filesStoreProbe(this.ctx.storage.sql, this.env.FILES, this.name)
  }

  /** The run ledger one turn leaves, and the restart sweep (ADR 0024), as JSON text. */
  telemetryProbe(): Promise<string> {
    return telemetryProbe(
      this.ctx.storage,
      this.name,
      async (text, operationId) => {
        await this.submit(PRIMARY_CHAT, text, operationId)
        return this.settle(PRIMARY_CHAT, operationId)
      },
      async (query) => {
        const request = new Request('https://agent/inspect', { method: 'POST', body: JSON.stringify(query) })
        return (await this.onRequest(request)).json()
      },
    )
  }

  /** As JSON text: the results carry app values, typed `unknown`, which RPC types cannot carry. */
  async appsEngineProbe(): Promise<string> {
    return JSON.stringify(await appsEngineProbe(this.ctx.storage, this.env, this.name))
  }

  async appsPowersProbe(): Promise<string> {
    return JSON.stringify(await appsPowersProbe(this.ctx.storage, this.env, this.name))
  }

  async appsTurnProbe(): Promise<string> {
    // This probe submits directly to Pi; establish the resident authority an owner request normally renews.
    new ResidentAuthority(drizzle(this.ctx.storage)).enable(Math.floor(Date.now() / 1000))
    const session = new ChatDirectory(drizzle(this.ctx.storage)).session(PRIMARY_CHAT)
    return JSON.stringify(await appsTurnProbe(this.harness, () => this.seen, session))
  }

  /** On this object's own native schedules, and its own `runAppJob` callback. */
  async appsJobsProbe(): Promise<string> {
    const schedules: JobSchedules = {
      list: () => this.listSchedules(),
      arm: async (at, slot) => (await this.schedule(new Date(at), JOB_CALLBACK, slot, { idempotent: true })).id,
      cancel: (id) => this.cancelSchedule(id),
    }
    const result = await appsJobsProbe(this.ctx.storage, this.env, this.name, schedules, {
      fire: (slot) => this.runAppJob(slot),
      fetch: (request) => this.onRequest(request),
    })
    return JSON.stringify(result)
  }
  async routineExecutionProbe(): Promise<Response> {
    return Response.json(await routineExecutionProbe(this.ctx.storage, this, this.seen))
  }
  async routineQuestionProbe(): Promise<Response> {
    return Response.json(await routineQuestionProbe(this.ctx.storage, this))
  }
  async routineRecoveryWrite(): Promise<Response> {
    return Response.json({ instance: this.instance, ...(await routineRecoveryWrite(this.ctx.storage, this)) })
  }
  async routineRecoveryRead(): Promise<Response> {
    return Response.json({ instance: this.instance, ...(await routineRecoveryRead(this.ctx.storage, this)) })
  }
  routineEvict() {
    this.ctx.abort('routine acceptance reconstruction')
  }
  /** A real Dynamic Worker writes before eviction interrupts its Pi tool intent. */
  async codeRecoveryWrite() {
    const files = new FileStore(this.ctx.storage.sql, this.env.FILES, () => this.name)
    await files.write('agent', '/agent/replay.txt', '', 'text/plain', 0)
    const code =
      "await files.write('/agent/replay.txt', (await files.read('/agent/replay.txt')) + 'x'); await new Promise(resolve => setTimeout(resolve, 30000)); return null"
    await this.submit(PRIMARY_CHAT, `call code_run ${JSON.stringify({ code })}`, 'code-recovery')
    const written = await until(
      () => files.text('/agent/replay.txt', 0, 100),
      (file) => file.text === 'x',
    )
    return JSON.stringify({ instance: this.instance, text: written.text })
  }
  async codeRecoveryRead() {
    const result = await this.settle(PRIMARY_CHAT, 'code-recovery')
    const files = new FileStore(this.ctx.storage.sql, this.env.FILES, () => this.name)
    return JSON.stringify({
      instance: this.instance,
      text: (await files.text('/agent/replay.txt', 0, 100)).text,
      result,
    })
  }
  routineStopProbe() {
    return routineStopProbe(this.ctx.storage, this)
  }
  routineScheduleProbe() {
    return routineScheduleProbe(this.ctx.storage, this)
  }
  async routineUsageProbe(): Promise<Response> {
    return Response.json(await routineUsageProbe(this.ctx.storage, this, this.seen))
  }
  async routineNotificationProbe(): Promise<Response> {
    return Response.json(await routineNotificationProbe(this.ctx.storage, this.name))
  }
  async routineEventsProbe(): Promise<Response> {
    return Response.json(await routineEventsProbe(this.ctx.storage, this, this.routineProducer, this.seen))
  }
  protected override mcpFetch(): typeof fetch {
    return (input, init) =>
      new URL(input instanceof Request ? input.url : String(input)).hostname === 'routine-events.test'
        ? this.routineProducer.fetch(input, init)
        : fetch(input, init)
  }

  skillsCacheProbe() {
    return skillsCacheProbe(this.ctx.storage)
  }

  protected override modelStreams(): ProviderStreams {
    return scriptedStreams(
      (request) => this.seen.push(request),
      undefined,
      (messages) =>
        messages.some((message) => message.content === 'Native slow job')
          ? 3000
          : messages.some(
                (message) => typeof message.content === 'string' && message.content.includes('Native slow routine'),
              )
            ? 1000
            : 0,
    )
  }

  /** Waits for an operation in a conversation to settle (the owner API has no wait route). */
  async settle(chat: string, operationId: string) {
    const directory = new ChatDirectory(drizzle(this.ctx.storage))
    const session = directory.operation(chat, operationId) ?? directory.session(chat)
    return this.harness.wait(operationId, { session })
  }

  /** Whether Pi runs a conversation now (the workspace feed carries this; the conversation list does not). */
  async busy(chat: string): Promise<boolean> {
    const directory = new ChatDirectory(drizzle(this.ctx.storage))
    return this.harness.session(directory.session(chat)).busy()
  }

  /**
   * The newest model request that answered `turn` (its last non-system message), as plain data: deep readonly types
   * do not cross the RPC stub. Matching the turn keeps the cheap model's own requests (thread titles) out of it.
   */
  requestFor(
    turn: string,
  ): { messages: { role: string; text: string }[]; systemPrompt: string; tools: string[] } | undefined {
    const request = this.seen.findLast(
      ({ messages }) => messages.findLast((message) => message.role !== 'system')?.text === turn,
    )
    if (request === undefined) return undefined
    return {
      messages: request.messages.map(({ role, text }) => ({ role, text })),
      systemPrompt: request.systemPrompt,
      tools: [...request.tools],
    }
  }

  /** `/probe` reads storage; every other path is the real agent's (thread events and snapshots). */
  override async onRequest(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== '/probe') return super.onRequest(request)
    const before = listTables(this.ctx.storage)
    runApplicationMigrations(this.ctx.storage)
    const after = listTables(this.ctx.storage)
    const metadata = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* AppMetadata
        yield* service.set('probe', 'stored-once')
        yield* service.set('probe', 'stored-updated')
        return yield* service.get('probe')
      }).pipe(Effect.provide(AppMetadata.layer(this.ctx.storage))),
    )
    return Response.json({ snapshot: await this.sessionSnapshot(PRIMARY_CHAT), before, after, metadata })
  }

  /** Endpoint binding on the real SQLite store: a re-pointed server loses its credentials, grants and pending state. */
  bindingProbe() {
    runApplicationMigrations(this.ctx.storage)
    const db = drizzle(this.ctx.storage)
    const stored = () => ({
      credentials: db.select().from(appMcpCredentials).all().length,
      grants: db.select().from(appMcpGrants).all().length,
      pending: db.select().from(appMcpOauthPending).all().length,
    })
    const first = bindEndpoints(db, notesAt('https://a.test/mcp'), 1)
    db.insert(appMcpCredentials)
      .values({ serverId: 'notes', status: 'connected', tokens: 'sealed', updatedAt: 1 })
      .run()
    db.insert(appMcpGrants).values({ serverId: 'notes', capability: 'tool', name: 'read', createdAt: 1 }).run()
    db.insert(appMcpOauthPending).values({ state: 's', serverId: 'notes', codeVerifier: 'v', createdAt: 1 }).run()
    const same = bindEndpoints(db, notesAt('https://a.test/mcp'), 2)
    const kept = stored()
    const moved = bindEndpoints(db, notesAt('https://b.test/mcp'), 3)
    const bound = db.select().from(appMcpEndpoints).all()
    // An added server, removed: its row, binding, credentials, grants and pending sign-ins all go.
    const added = new AddedServerStore(db)
    added.add({ serverId: 'extra', endpoint: 'https://extra.test/mcp', title: 'Extra' }, 4)
    db.insert(appMcpCredentials)
      .values({ serverId: 'extra', status: 'connected', tokens: 'sealed', updatedAt: 4 })
      .run()
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
  seedNotes() {
    runApplicationMigrations(this.ctx.storage)
    const db = drizzle(this.ctx.storage)
    new AddedServerStore(db).add({ serverId: 'notes', endpoint: 'https://notes.test/mcp', title: 'Notes' }, 1)
    for (const name of ['read', 'write'])
      db.insert(appMcpGrants).values({ serverId: 'notes', capability: 'tool', name, createdAt: 1 }).run()
  }

  /**
   * Conversation switches on the real SQLite store: a thread copies main's, a subagent two levels down is bounded by
   * every conversation above it, one whose spawner is unknown (or an unknown session) may use nothing.
   */
  async scopeProbe() {
    runApplicationMigrations(this.ctx.storage)
    const db = drizzle(this.ctx.storage)
    db.insert(appConversations)
      .values([
        { chatId: PRIMARY_CHAT, piSession: PRIMARY_CHAT, kind: 'main', createdAt: 1 },
        { chatId: '900', piSession: '900', kind: 'thread', parentSession: PRIMARY_CHAT, createdAt: 1 },
        { chatId: '901', piSession: '901', kind: 'subagent', parentSession: '900', createdAt: 1 },
        { chatId: '902', piSession: '902', kind: 'subagent', parentSession: '901', createdAt: 1 },
        { chatId: '903', piSession: '903', kind: 'subagent', parentSession: '999', createdAt: 1 },
      ])
      .onConflictDoNothing()
      .run()
    const tool = defineTool({
      name: 'subagent',
      description: '',
      parameters: Type.Object({}),
      execute: async () => ({ content: [] }),
    })
    const retooled: string[] = []
    const profiles = new CapabilityProfiles(
      db,
      [tool],
      async (session) => void retooled.push(session),
      new ChatDirectory(db),
    )
    profiles.set(PRIMARY_CHAT, { kind: 'tool', serverId: 'notes', name: 'write' }, false, 1)
    profiles.copy(PRIMARY_CHAT, '900', 2)
    profiles.set('900', { kind: 'server', serverId: 'mail' }, false, 2)
    profiles.set('900', { kind: 'tool', serverId: 'mail', name: 'send' }, false, 2)
    profiles.set('901', { kind: 'skills', serverId: 'myskills' }, false, 2)
    const view = (session: string) => {
      const scope = profiles.scope(session)
      return {
        editable: scope.editable,
        mail: scope.server('mail'),
        send: scope.tool('mail', 'send'),
        read: scope.tool('notes', 'read'),
        write: scope.tool('notes', 'write'),
        skills: scope.skills('myskills'),
        subagents: scope.subagents(),
      }
    }
    // Twenty subagents deep is bounded by the thread at the top, not refused; a cycle of spawners may use nothing.
    const chain = Array.from({ length: 20 }, (_, index) => ({
      chatId: String(910 + index),
      piSession: String(910 + index),
      kind: 'subagent' as const,
      parentSession: index === 0 ? '900' : String(909 + index),
      createdAt: 1,
    }))
    // Keep each fixture insert below workerd SQLite's 100 bound-parameter limit.
    for (const row of chain) db.insert(appConversations).values(row).run()
    db.insert(appConversations)
      .values([
        { chatId: '950', piSession: '950', kind: 'subagent', parentSession: '951', createdAt: 1 },
        { chatId: '951', piSession: '951', kind: 'subagent', parentSession: '950', createdAt: 1 },
        { chatId: '960', piSession: '960', kind: 'thread', parentSession: '902', createdAt: 1 },
      ])
      .run()
    // A thread branched from a subagent copies what the subagent works under: every spawner's switches.
    profiles.copy('902', '960', 2)
    const before = {
      thread: view('900'),
      deep: view('902'),
      orphan: view('903'),
      unknown: view('12345'),
      deepest: view('929'),
      cycle: view('950'),
      fromSubagent: view('960'),
    }
    profiles.set('900', { kind: 'server', serverId: 'mail' }, true, 3)
    const serverBackOn = view('900')
    await profiles.reset('900', 4)
    const afterReset = view('900')
    const reset = [...retooled]
    // Once per marker: every conversation that filters the subagent tools (subagents off, or a broken chain) again.
    profiles.set('960', { kind: 'subagents' }, false, 5)
    await profiles.retoolOnce('retool:probe', 5)
    const once = retooled.slice(reset.length).toSorted()
    await profiles.retoolOnce('retool:probe', 6)
    const again = retooled.length - reset.length - once.length
    return { ...before, serverBackOn, afterReset, own: profiles.own('900'), retooled: reset, once, again }
  }
}

/** Same public factory/lifecycle seam as PersonalAgent, with a keyless deterministic model. */
export class NativeLifecycleProbe extends Agent<Env> {
  readonly instance = String(Effect.runSync(nextInt))
  readonly harness = new PiHarness({
    harness: ({ storage, context }) =>
      Harness.open(storage, { models: fixtureModels(), registry: createRegistry() }, context),
    defaults: { model, thinkingLevel: 'low' },
  })

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.lifecycle.use(this.harness)
  }

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const operationId = url.searchParams.get('operationId') ?? 'missing-fixture-operation'
    if (url.pathname === '/lifecycle/skills-rejection')
      return Response.json(await skillsLearnerRejectionProbe(this.ctx.storage, this.harness))
    if (url.pathname === '/lifecycle/skills-write') {
      await skillsCacheProbe(this.ctx.storage)
      return Response.json({ instance: this.instance, retained: await skillsPersistedRead(this.ctx.storage) })
    }
    if (url.pathname === '/lifecycle/skills-read')
      return Response.json({ instance: this.instance, retained: await skillsPersistedRead(this.ctx.storage) })
    if (url.pathname === '/lifecycle/skills-evict') this.ctx.abort('skills acceptance restart')
    if (url.pathname === '/lifecycle/submit')
      return Response.json(await this.harness.submit(FIXTURE_INPUT, { operationId }))
    if (url.pathname === '/lifecycle/wait') return Response.json(await this.harness.wait(operationId))
    if (url.pathname === '/lifecycle/read')
      return Response.json({ instance: this.instance, messages: await this.harness.messages() })
    if (url.pathname === '/lifecycle/reopen') {
      const before = await this.harness.pi()
      await this.harness.dispose()
      const after = await this.harness.pi()
      return Response.json({ replacedPiInstance: before !== after, messages: await this.harness.messages() })
    }
    return Response.json({ sessions: await this.harness.sessions.list() })
  }
}

interface Env {
  readonly AGENTS: DurableObjectNamespace<PersonalAgentProbe>
  readonly LIFECYCLE: DurableObjectNamespace<NativeLifecycleProbe>
  readonly FILES: R2Bucket
}

/** Owner RPC through a real stub: resident authority renews, revocation is sticky, errors cross as AppError data. */
async function rpcSequence(agent: DurableObjectStub<PersonalAgentProbe>): Promise<Response> {
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
  const noConversation = await agent.recentMessages(5)
  const thread = await agent.createConversation({})
  const threads = await agent.conversations()
  const badBranch = await branchMain(agent, 999_999)
  const unknownThread = await agent.submit('424242', 'hello', 'op-unknown-thread')
  const closed = thread.ok ? await agent.updateConversation(thread.value.id, { closed: true }) : thread
  const mainUntouchable = await agent.updateConversation(PRIMARY_CHAT, { title: 'renamed' })
  const usage = await ownerResult(agent, (api) => api.agent.usage())
  const modelChoice = await ownerResult(agent, (api) => api.agent.model())
  const unknownModel = await ownerResult(agent, (api) => api.agent.chooseModel({ payload: { model: 'not-offered' } }))
  await callOwner(agent, (api) => api.resident.set({ payload: { enabled: false } }))
  const askWhileRevoked = await agent.askAsClient('Test client', 'hello', 'op-1', 1000)
  return Response.json({
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
    model: modelChoice,
    unknownModel,
    askWhileRevoked,
  })
}

/** A thread branched from main at `entry`; with no entry, a request the agent refuses. */
const branchMain = (agent: DurableObjectStub<PersonalAgentProbe>, entry: number | undefined) =>
  agent.createConversation({ from: { conversation: PRIMARY_CHAT, entry: entry ?? 0 } })

const entries = async (agent: DurableObjectStub<PersonalAgentProbe>): Promise<number> => {
  const body: { snapshot?: { entries?: unknown[] } } = await (await agent.fetch('https://agent/probe')).json()
  return body.snapshot?.entries?.length ?? -1
}

/** How the thread list shows one conversation now. */
async function listedThread(agent: DurableObjectStub<PersonalAgentProbe>, id: string) {
  const threads = await agent.conversations()
  return threads.ok ? threads.value.find((view) => view.id === id) : undefined
}

/**
 * A thread branched at main's answer sees main up to there and goes on alone: main never sees the thread's turn, and
 * the thread's request carried main's history. The thread list counts only the thread's own messages, turn by turn.
 */
async function branchSequence(agent: DurableObjectStub<PersonalAgentProbe>): Promise<Response> {
  await agent.submit(PRIMARY_CHAT, 'remember the word lantern', 'branch-main')
  await agent.settle(PRIMARY_CHAT, 'branch-main')
  const snapshot = await snapshotOf(agent, PRIMARY_CHAT)
  const answer = (snapshot.entries ?? []).findLast((entry) => entry.kind === 'pi.assistant')
  const thread = await branchMain(agent, answer?.id)
  if (!thread.ok) return Response.json({ thread })
  const before = await listedThread(agent, thread.value.id)
  await agent.submit(thread.value.id, 'what was the word?', 'branch-thread')
  const settled = await agent.settle(thread.value.id, 'branch-thread')
  const branch = await transcript(agent, thread.value.id)
  const afterOne = await listedThread(agent, thread.value.id)
  await agent.submit(thread.value.id, 'and once more?', 'branch-thread-again')
  await agent.settle(thread.value.id, 'branch-thread-again')
  return Response.json({
    thread: thread.value,
    settled,
    main: await transcript(agent, PRIMARY_CHAT),
    branch,
    request: await agent.requestFor('what was the word?'),
    forkedAt: answer?.id,
    before,
    afterOne,
    afterTwo: await listedThread(agent, thread.value.id),
  })
}

/**
 * A thread shares a note with main: main's next request carries it, labelled with the thread, and it started no run
 * of its own. Only the thread is offered `share_back`, and the thread is named after its first exchange. The thread
 * is branched, so main gets no note of its start (that is for threads started with "+": `announceSequence`).
 */
async function shareSequence(agent: DurableObjectStub<PersonalAgentProbe>): Promise<Response> {
  await agent.submit(PRIMARY_CHAT, 'remember the word lantern', 'share-main')
  await agent.settle(PRIMARY_CHAT, 'share-main')
  const answer = ((await historyOf(agent, PRIMARY_CHAT)).entries ?? []).findLast(({ kind }) => kind === 'pi.assistant')
  const thread = await branchMain(agent, answer?.id)
  if (!thread.ok) return Response.json({ thread })
  const share = 'call share_back {"note":"the word is lantern"}'
  await agent.submit(thread.value.id, share, 'share-thread')
  const shared = await agent.settle(thread.value.id, 'share-thread')
  await agent.submit(PRIMARY_CHAT, 'what did the thread say?', 'share-ask')
  await agent.settle(PRIMARY_CHAT, 'share-ask')
  return Response.json({
    shared,
    main: await transcript(agent, PRIMARY_CHAT),
    mainRequest: await agent.requestFor('what did the thread say?'),
    threadRequest: await agent.requestFor(share),
    // The cheap model names the thread in the background.
    title: (await threadsUntil(agent, (views) => views.some(({ id, title }) => id === thread.value.id && title))).find(
      ({ id }) => id === thread.value.id,
    )?.title,
  })
}

/** Main's notes of threads started with "+", once they are in. */
const notesUntil = (agent: DurableObjectStub<PersonalAgentProbe>, count: number) =>
  until(
    async () => (await transcript(agent, PRIMARY_CHAT)).filter((line) => line.startsWith('app.thread_started')),
    (notes) => notes.length >= count,
  )

/**
 * A thread started with "+" tells main its name, once, after its first exchange names it: main's model reads the
 * note, no run starts for it, and a second exchange or a branched thread adds none.
 */
async function announceSequence(agent: DurableObjectStub<PersonalAgentProbe>): Promise<Response> {
  await agent.submit(PRIMARY_CHAT, 'remember the word lantern', 'announce-main')
  await agent.settle(PRIMARY_CHAT, 'announce-main')
  const fresh = await agent.createConversation({})
  if (!fresh.ok) return Response.json({ fresh })
  await agent.submit(fresh.value.id, 'plan the trip', 'announce-thread')
  await agent.settle(fresh.value.id, 'announce-thread')
  const first = await notesUntil(agent, 1)
  await agent.submit(fresh.value.id, 'and the hotel?', 'announce-thread-again')
  await agent.settle(fresh.value.id, 'announce-thread-again')
  const answer = ((await historyOf(agent, PRIMARY_CHAT)).entries ?? []).findLast(({ kind }) => kind === 'pi.assistant')
  const branched = await branchMain(agent, answer?.id)
  if (!branched.ok) return Response.json({ branched })
  await agent.submit(branched.value.id, 'what was the word?', 'announce-branch')
  await agent.settle(branched.value.id, 'announce-branch')
  await threadsUntil(agent, (views) => views.some(({ id, title }) => id === branched.value.id && title))
  await agent.submit(PRIMARY_CHAT, 'which threads did I start?', 'announce-ask')
  await agent.settle(PRIMARY_CHAT, 'announce-ask')
  const mainEntries = (await historyOf(agent, PRIMARY_CHAT)).entries ?? []
  return Response.json({
    thread: fresh.value.id,
    title: (await listedThread(agent, fresh.value.id))?.title,
    first,
    notes: mainEntries.filter(({ kind }) => kind === 'app.thread_started').map(({ data }) => data),
    main: linesOf(mainEntries),
    request: await agent.requestFor('which threads did I start?'),
  })
}

/** The newest answer in main: what a thread can branch from. */
const mainAnswer = async (agent: DurableObjectStub<PersonalAgentProbe>) =>
  ((await snapshotOf(agent, PRIMARY_CHAT)).entries ?? []).findLast(({ kind }) => kind === 'pi.assistant')?.id

/**
 * The owner's switches per conversation: main switches a tool and subagents off, a new thread (empty or branched)
 * copies that, the `subagent` tool leaves the request where subagents are off and comes back where they are turned on,
 * and Reset gives a thread main's switches again. Only what is shown can be switched off; main has no reset.
 */
async function capabilitySequence(agent: DurableObjectStub<PersonalAgentProbe>): Promise<Response> {
  await agent.seedNotes()
  const mainBefore = await agent.conversationCapabilities(PRIMARY_CHAT)
  await agent.setConversationCapability(PRIMARY_CHAT, {
    target: { kind: 'tool', serverId: 'notes', name: 'write' },
    on: false,
  })
  const mainAfter = await agent.setConversationCapability(PRIMARY_CHAT, { target: { kind: 'subagents' }, on: false })
  await exchange(agent, PRIMARY_CHAT, 'which tools do you have?', 'capabilities-main')
  const fresh = await agent.createConversation({})
  const branched = await branchMain(agent, await mainAnswer(agent))
  if (!fresh.ok || !branched.ok) return Response.json({ fresh, branched })
  const freshView = await agent.conversationCapabilities(fresh.value.id)
  const branchedView = await agent.conversationCapabilities(branched.value.id)
  const freshOn = await agent.setConversationCapability(fresh.value.id, { target: { kind: 'subagents' }, on: true })
  await exchange(agent, fresh.value.id, 'and in the thread?', 'capabilities-thread')
  await exchange(agent, branched.value.id, 'and in the branch?', 'capabilities-branch')
  const reset = await agent.setConversationCapability(fresh.value.id, { reset: 'parent' })
  await exchange(agent, fresh.value.id, 'and after the reset?', 'capabilities-reset')
  // A tool switched off runs nothing (the unreachable server is never asked) and the result offers it to the owner.
  const offCall = 'call mcp_call {"serverId":"notes","name":"write","arguments":{}}'
  const off = await exchange(agent, PRIMARY_CHAT, offCall, 'capabilities-off-call')
  const offResult = ((await historyOf(agent, PRIMARY_CHAT)).entries ?? []).findLast(
    ({ kind }) => kind === 'pi.tool-result',
  )
  await agent.setConversationCapability(branched.value.id, { target: { kind: 'server', serverId: 'notes' }, on: false })
  const listed = await exchange(agent, branched.value.id, 'call mcp_list {}', 'capabilities-list')
  return Response.json({
    off,
    offDetails: offResult?.model?.[0]?.details,
    listed,
    mainBefore,
    mainAfter,
    freshView,
    branchedView,
    freshOn,
    reset,
    unknown: await agent.setConversationCapability(PRIMARY_CHAT, {
      target: { kind: 'server', serverId: 'nope' },
      on: false,
    }),
    mainReset: await agent.setConversationCapability(PRIMARY_CHAT, { reset: 'parent' }),
    tools: {
      main: (await agent.requestFor('which tools do you have?'))?.tools,
      thread: (await agent.requestFor('and in the thread?'))?.tools,
      branch: (await agent.requestFor('and in the branch?'))?.tools,
      reset: (await agent.requestFor('and after the reset?'))?.tools,
    },
  })
}

/**
 * Main spawns a subagent: it works in its own conversation with the owner's tools but no subagents or ask_user, and
 * its answer comes back into main as a passive Delegate result labelled with it, which main does not answer.
 */
async function subagentSequence(agent: DurableObjectStub<PersonalAgentProbe>): Promise<Response> {
  const spawn = `call subagent_spawn ${JSON.stringify({ name: 'scout', message: 'find the word' })}`
  await agent.submit(PRIMARY_CHAT, spawn, 'subagent-spawn')
  const spawned = await agent.settle(PRIMARY_CHAT, 'subagent-spawn')
  await until(
    () => transcript(agent, PRIMARY_CHAT),
    (lines) => lines.some((line) => line.includes('[from subagent')),
  )
  // The report is a passive Delegate result: a Goblin run that wrongly followed it would show after a moment.
  await new Promise((resolve) => setTimeout(resolve, 600))
  const main = await transcript(agent, PRIMARY_CHAT)
  const listed = (await threadsUntil(agent, (views) => views.some(({ kind }) => kind === 'subagent'))).find(
    ({ kind }) => kind === 'subagent',
  )
  const subagent = listed === undefined ? undefined : await idle(agent, listed)
  return Response.json({
    spawned,
    main,
    subagent,
    child: subagent === undefined ? [] : await transcript(agent, subagent.id),
    mainRequest: await agent.requestFor(spawn),
    childRequest: await agent.requestFor('find the word'),
  })
}

/** The newest answer in a conversation: what a thread can branch from. */
const answerIn = async (agent: DurableObjectStub<PersonalAgentProbe>, session: string) =>
  ((await snapshotOf(agent, session)).entries ?? []).findLast(({ kind }) => kind === 'pi.assistant')?.id ?? 0

/** A conversation once Pi no longer runs it. */
const idle = async (agent: DurableObjectStub<PersonalAgentProbe>, view: ConversationView) => {
  await until(
    () => agent.busy(view.id),
    (busy) => !busy,
  )
  return view
}

/**
 * Conversations form a tree: a thread branches from another thread, Close shuts a thread with everything under it (its
 * subagent stops mid-job), a closed conversation takes no message, and Reopen opens only the one asked for.
 */
async function treeSequence(agent: DurableObjectStub<PersonalAgentProbe>): Promise<Response> {
  await exchange(agent, PRIMARY_CHAT, 'remember the word lantern', 'tree-main')
  const outer = await branchMain(agent, await mainAnswer(agent))
  if (!outer.ok) return Response.json({ outer })
  await exchange(agent, outer.value.id, 'what was the word?', 'tree-outer')
  const nested = await agent.createConversation({
    from: { conversation: outer.value.id, entry: await answerIn(agent, outer.value.id) },
  })
  if (!nested.ok) return Response.json({ nested })
  await exchange(agent, nested.value.id, 'and in the nested thread?', 'tree-nested')
  const spawn = `call subagent_spawn ${JSON.stringify({ name: 'digger', message: 'Native slow job' })}`
  await exchange(agent, outer.value.id, spawn, 'tree-spawn')
  const subagent = (await threadsUntil(agent, (views) => views.some(({ parent }) => parent === outer.value.id))).find(
    ({ kind, parent }) => kind === 'subagent' && parent === outer.value.id,
  )
  if (subagent === undefined) return Response.json({ subagent })
  const working = await until(
    () => agent.busy(subagent.id),
    (busy) => busy,
  )
  const closed = await agent.updateConversation(outer.value.id, { closed: true })
  const stopped = !(await agent.busy(subagent.id))
  const closedViews = await agent.conversations()
  const refused = await agent.submit(nested.value.id, 'still there?', 'tree-refused')
  const reopened = await agent.updateConversation(outer.value.id, { closed: false })
  const reopenedViews = await agent.conversations()
  const main = await agent.updateConversation(PRIMARY_CHAT, { closed: true })
  return Response.json({
    outer: outer.value,
    nested: nested.value,
    nestedRequest: await agent.requestFor('and in the nested thread?'),
    working,
    closed,
    stopped,
    closedViews: closedViews.ok ? closedViews.value : [],
    refused,
    reopened,
    reopenedViews: reopenedViews.ok ? reopenedViews.value : [],
    subagent: subagent.id,
    main,
  })
}

/**
 * A thread branched from a subagent's answer is an owner's thread: its agent is the host's (with `ask_user` and
 * subagents, without the subagent's instructions), it reads the subagent's work, and the subagent stays open for it.
 */
async function subagentBranchSequence(agent: DurableObjectStub<PersonalAgentProbe>): Promise<Response> {
  const spawn = `call subagent_spawn ${JSON.stringify({ name: 'scout', message: 'find the word' })}`
  await exchange(agent, PRIMARY_CHAT, spawn, 'subagent-branch-spawn')
  const listed = (await threadsUntil(agent, (views) => views.some(({ kind }) => kind === 'subagent'))).find(
    ({ kind }) => kind === 'subagent',
  )
  if (listed === undefined) return Response.json({ listed })
  // Its job done, the subagent closed; the owner reopens it to branch from its answer.
  const done = await threadsUntil(
    agent,
    (views) => views.some(({ id, closedBy }) => id === listed.id && closedBy === 'done'),
    15_000,
  )
  await agent.updateConversation(listed.id, { closed: false })
  const branch = await agent.createConversation({
    from: { conversation: listed.id, entry: await answerIn(agent, listed.id) },
  })
  if (!branch.ok) return Response.json({ branch })
  await exchange(agent, branch.value.id, 'what did you find?', 'subagent-branch-ask')
  // The subagent already offered `subagent`, so the thread's request lists only what it adds: use the tool instead.
  const status = await exchange(agent, branch.value.id, 'call subagent_status {}', 'subagent-branch-status')
  const subagentAfter = (await agent.conversations()).ok ? await listedThread(agent, listed.id) : undefined
  const closed = await agent.updateConversation(listed.id, { closed: true })
  return Response.json({
    doneClosed: done.find(({ id }) => id === listed.id),
    status,
    branch: branch.value,
    request: await agent.requestFor('what did you find?'),
    subagentAfter,
    closed,
    branchAfter: await listedThread(agent, branch.value.id),
    keepOpenThread: await agent.updateConversation(branch.value.id, { keepOpen: true }),
  })
}

/** Server-Sent Events from a response, one `{ event, data }` at a time, until `deadline` (ms since the epoch). */
async function* sseEvents(response: Response, deadline: number) {
  const reader = response.body?.getReader()
  if (reader === undefined) return
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (Date.now() < deadline) {
      const timeout = new Promise<undefined>((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())))
      const read = await Promise.race([reader.read(), timeout])
      if (read === undefined || read.done) return
      buffer += decoder.decode(read.value, { stream: true })
      for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const event = /^event: (.*)$/mu.exec(frame)?.[1]
        const data = /^data: (.*)$/mu.exec(frame)?.[1]
        if (event === undefined || data === undefined) continue
        const value: unknown = JSON.parse(data)
        yield { event, data: value }
      }
    }
  } finally {
    await reader.cancel()
  }
}

/**
 * The workspace feed: a snapshot of every conversation first, then the changes as they land: a new thread, its run
 * working then idle (with its replies counted again), and its Close.
 */
async function feedSequence(agent: DurableObjectStub<PersonalAgentProbe>): Promise<Response> {
  const events = sseEvents(await agent.fetch('https://agent/workspace/events'), Date.now() + 8000)
  const first = await events.next()
  const created = await agent.createConversation({})
  if (!created.ok) return Response.json({ created })
  const id = created.value.id
  await agent.submit(id, 'Native slow job', 'feed-turn')
  const changes: unknown[] = []
  let stage: 'running' | 'reading' | 'closing' = 'running'
  for await (const { event, data } of events) {
    if (event !== 'change' || !Array.isArray(data)) continue
    changes.push(...data)
    const text = JSON.stringify(changes)
    if (stage === 'running' && text.includes('"state":"idle"') && text.includes('"replies":2')) {
      stage = 'reading'
      await agent.markRead(id)
    }
    if (stage === 'reading' && text.includes('"readAt"')) {
      stage = 'closing'
      await agent.updateConversation(id, { closed: true })
    }
    if (stage === 'closing' && text.includes('"closedBy":"owner"')) break
  }
  return Response.json({ snapshot: first.value, id, changes })
}

/**
 * Main remembers: after two turns the builder places a view of the first, so the next request reads the view, then
 * the second turn verbatim; `zoom` opens a line of it, and the history route still serves what the view replaced.
 */
async function memorySequence(agent: DurableObjectStub<PersonalAgentProbe>): Promise<Response> {
  for (const [input, operation] of [
    ['remember alpha', 'memory-1'],
    ['remember beta', 'memory-2'],
  ] as const) {
    await agent.submit(PRIMARY_CHAT, input, operation)
    await agent.settle(PRIMARY_CHAT, operation)
  }
  const summarized = await until(
    async () =>
      callOwner(agent, (api) =>
        api.memory.status({ query: {} }).pipe(
          Effect.map((status) => status.summarized),
          // expected: until polls again; a failed read counts as nothing summarized yet, as it did before
          Effect.orElseSucceed(() => 0),
        ),
      ),
    (count) => count >= 2,
  )
  await agent.submit(PRIMARY_CHAT, 'what do you remember?', 'memory-3')
  await agent.settle(PRIMARY_CHAT, 'memory-3')
  await agent.submit(PRIMARY_CHAT, 'call zoom {"id":0,"n":1}', 'memory-4')
  const zoomed = await agent.settle(PRIMARY_CHAT, 'memory-4')
  const view = (await snapshotOf(agent, PRIMARY_CHAT)).entries?.[0]
  return Response.json({
    summarized,
    request: await agent.requestFor('what do you remember?'),
    zoomed,
    view: view?.kind,
    earlier: linesOf((await historyOf(agent, PRIMARY_CHAT, view?.head)).entries ?? []),
  })
}

/** Account deletion's agent half: state before, what the caller of deleteAgentData sees, state after. */
async function destroySequence(env: Env, name: string): Promise<Response> {
  const agent = env.AGENTS.getByName(name)
  await callOwner(agent, (api) => api.resident.set({ payload: { enabled: false } }))
  const submitted = await agent.submit(PRIMARY_CHAT, 'remember this before deletion', 'destroy-op-1')
  const before = await entries(agent)
  let deleted: unknown
  try {
    deleted = await agent.deleteAgentData()
  } catch (cause) {
    deleted = { thrown: cause instanceof Error ? cause.message : 'unknown' }
  }
  const fresh = env.AGENTS.getByName(name)
  return Response.json({
    submitted,
    before,
    deleted,
    after: await entries(fresh),
    resident: await ownerResult(fresh, (api) => api.resident.status()),
  })
}

/** The agent apps probes, which answer JSON text (their results carry app values RPC types cannot). */
const APPS_PROBES: Readonly<Record<string, (agent: DurableObjectStub<PersonalAgentProbe>) => Promise<string>>> = {
  '/home-probe': (agent) => agent.homeProbe(),
  '/home-retained': (agent) => agent.homeRetained(),
  '/inbox-app': (agent) => agent.inboxAppProbe(),
  '/apps-engine': (agent) => agent.appsEngineProbe(),
  '/apps-powers': (agent) => agent.appsPowersProbe(),
  '/apps-turn': (agent) => agent.appsTurnProbe(),
  '/apps-jobs': (agent) => agent.appsJobsProbe(),
  '/code-recovery-write': (agent) => agent.codeRecoveryWrite(),
  '/code-recovery-read': (agent) => agent.codeRecoveryRead(),
}

const primaryProfileFetch = (agent: DurableObjectStub<PersonalAgentProbe>) =>
  agent.primaryProfileProbe().then((result) => Response.json(result))

function nativeFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const name = url.searchParams.get('name') ?? 'initialization'
  const agent = env.AGENTS.getByName(name)
  const apps = APPS_PROBES[url.pathname]
  if (apps !== undefined)
    return apps(agent).then((json) => new Response(json, { headers: { 'content-type': 'application/json' } }))
  switch (url.pathname) {
    case '/primary-profile':
      return primaryProfileFetch(agent)
    case '/events-probe':
      return agent.eventsProbe().then((result) => Response.json(result))
    case '/routines-probe':
      return agent.routinesProbe().then((result) => Response.json(result))
    case '/routine-execution':
      return agent.routineExecutionProbe()
    case '/routine-question':
      return agent.routineQuestionProbe()
    case '/routine-recovery-write':
      return agent.routineRecoveryWrite()
    case '/routine-recovery-read':
      return agent.routineRecoveryRead()
    case '/routine-evict':
      return agent.routineEvict().then(() => Response.json({ evicted: true }))
    case '/routine-stop':
      return agent.routineStopProbe().then((result) => Response.json(result))
    case '/routine-schedule':
      return agent.routineScheduleProbe().then((result) => Response.json(result))
    case '/routine-usage':
      return agent.routineUsageProbe()
    case '/routine-notifications':
      return agent.routineNotificationProbe()
    case '/routine-events':
      return agent.routineEventsProbe()
    case '/rpc':
      return rpcSequence(agent)
    case '/skills-cache':
      return agent.skillsCacheProbe().then((result) => Response.json(result))
    case '/composer':
      return composerSequence(agent)
    case '/destroy':
      return destroySequence(env, name)
    case '/branch':
      return branchSequence(agent)
    case '/share':
      return shareSequence(agent)
    case '/announce':
      return announceSequence(agent)
    case '/capabilities':
      return capabilitySequence(agent)
    case '/scopes':
      return agent.scopeProbe().then((result) => Response.json(result))
    case '/subagent':
      return subagentSequence(agent)
    case '/tree':
      return treeSequence(agent)
    case '/feed':
      return feedSequence(agent)
    case '/subagent-branch':
      return subagentBranchSequence(agent)
    case '/subagent-chain':
      return subagentChainSequence(agent)
    case '/subagent-owner':
      return subagentOwnerSequence(agent)
    case '/subagent-close':
      return subagentCloseSequence(agent)
    case '/subagent-synthesis':
      return subagentSynthesisSequence(agent)
    case '/memory':
      return memorySequence(agent)
    case '/topic-memory':
      return topicMemorySequence(agent)
    case '/topic-routine':
      return topicRoutineSequence(agent)
    case '/binding':
      return agent.bindingProbe().then((result) => Response.json(result))
    case '/telemetry':
      return agent
        .telemetryProbe()
        .then((json) => new Response(json, { headers: { 'content-type': 'application/json' } }))
    case '/files-store':
      return agent.filesStoreProbe().then((result) => Response.json(result))
    case '/files-sequence':
      return filesSequence(agent, env.FILES, name).then((result) => Response.json(result))
    default:
      return url.pathname.startsWith('/lifecycle') ? env.LIFECYCLE.getByName(name).fetch(request) : agent.fetch(request)
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === '/inbound-host') return inboundHostProbe(request)
    if (new URL(request.url).pathname.startsWith('/canonical'))
      return Promise.resolve(canonicalRedirect(request, 'https://goblin.surf') ?? Response.json({ canonical: true }))
    return nativeFetch(request, env)
  },
}
