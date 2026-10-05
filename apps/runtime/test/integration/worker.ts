import type { EntitlementPolicy } from '../../src/billing/gates.ts'
import { canonicalRedirect } from '../../src/http/canonical.ts'
import { inboundHostProbe } from './inbound-host.ts'
import { type ConversationView, MAIN_THREAD } from '@purrable/contracts'
import { eventsProbe } from './events-probe.ts'
import { routinesProbe } from './routines-probe.ts'
import { routineExecutionProbe } from './routines-execution.ts'
import { routineQuestionProbe, routineStopProbe, routineRecoveryWrite, routineRecoveryRead } from './routines-safety.ts'
import { routineScheduleProbe } from './routines-scheduling.ts'
import { routineUsageProbe } from './routines-usage.ts'
import { routineNotificationProbe } from './routines-notifications.ts'
import { routineEventsProbe } from './routines-events.ts'
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
import { skillsCacheProbe, skillsLearnerRejectionProbe, skillsPersistedRead } from './skills-probe.ts'

const fixturePlan = () =>
  Effect.succeed({
    active: true,
    source: 'override' as const,
    until: null,
    dailyTokens: 300_000,
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

  protected override entitlementPolicy(): EntitlementPolicy {
    return { state: fixturePlan, require: fixturePlan }
  }

  eventsProbe() {
    return eventsProbe(this.ctx.storage, this.harness)
  }

  routinesProbe() {
    return routinesProbe(this.ctx.storage)
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
  async settle(session: string, operationId: string) {
    return this.harness.wait(operationId, { session })
  }

  /** Whether Pi runs a conversation now (the workspace feed carries this; the conversation list does not). */
  busy(session: string): Promise<boolean> {
    return this.harness.session(session).busy()
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
    return Response.json({ snapshot: await this.sessionSnapshot(MAIN_THREAD), before, after, metadata })
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
        { sessionId: MAIN_THREAD, kind: 'main', createdAt: 1 },
        { sessionId: '900', kind: 'thread', parentSession: MAIN_THREAD, createdAt: 1 },
        { sessionId: '901', kind: 'subagent', parentSession: '900', createdAt: 1 },
        { sessionId: '902', kind: 'subagent', parentSession: '901', createdAt: 1 },
        { sessionId: '903', kind: 'subagent', parentSession: '999', createdAt: 1 },
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
    const profiles = new CapabilityProfiles(db, tool, async (session) => void retooled.push(session))
    profiles.set(MAIN_THREAD, { kind: 'tool', serverId: 'notes', name: 'write' }, false, 1)
    profiles.copy(MAIN_THREAD, '900', 2)
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
      sessionId: String(910 + index),
      kind: 'subagent' as const,
      parentSession: index === 0 ? '900' : String(909 + index),
      createdAt: 1,
    }))
    db.insert(appConversations).values(chain).run()
    db.insert(appConversations)
      .values([
        { sessionId: '950', kind: 'subagent', parentSession: '951', createdAt: 1 },
        { sessionId: '951', kind: 'subagent', parentSession: '950', createdAt: 1 },
        { sessionId: '960', kind: 'thread', parentSession: '902', createdAt: 1 },
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
    return { ...before, serverBackOn, afterReset: view('900'), own: profiles.own('900'), retooled }
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
}

/** Owner RPC through a real stub: resident authority renews, revocation is sticky, errors cross as AppError data. */
async function rpcSequence(agent: DurableObjectStub<PersonalAgentProbe>): Promise<Response> {
  const first = await agent.residentStatus()
  const revoked = await agent.residentSet(false)
  const afterOwnerRequest = await agent.residentStatus()
  const enabled = await agent.residentSet(true)
  const servers = await agent.mcpServers()
  const unknownServer = await agent.mcpSetToolGrant('missing', 'tool', true)
  const unknownApp = await agent.mcpSetAppGrant('missing', 'ui://missing/app.html', true)
  const noConversation = await agent.recentMessages(5)
  const thread = await agent.createConversation({})
  const threads = await agent.conversations()
  const badBranch = await branchMain(agent, 999_999)
  const unknownThread = await agent.submit('424242', 'hello', 'op-unknown-thread')
  const closed = thread.ok ? await agent.updateConversation(thread.value.id, { closed: true }) : thread
  const mainUntouchable = await agent.updateConversation(MAIN_THREAD, { title: 'renamed' })
  const usage = await agent.usageToday()
  const modelChoice = await agent.modelChoice()
  const unknownModel = await agent.chooseModel('not-offered')
  await agent.residentSet(false)
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
  agent.createConversation({ from: { conversation: MAIN_THREAD, entry: entry ?? 0 } })

const entries = async (agent: DurableObjectStub<PersonalAgentProbe>): Promise<number> => {
  const body: { snapshot?: { entries?: unknown[] } } = await (await agent.fetch('https://agent/probe')).json()
  return body.snapshot?.entries?.length ?? -1
}

type Entry = {
  readonly id: number
  readonly kind: string
  readonly head?: number
  readonly data?: unknown
  readonly model?: readonly { readonly content?: unknown; readonly details?: unknown }[]
}

/** A conversation's snapshot through the same route the Worker proxies (`/threads/<id>/snapshot`). */
const snapshotOf = async (
  agent: DurableObjectStub<PersonalAgentProbe>,
  session: string,
): Promise<{ entries?: Entry[] }> => (await agent.fetch(`https://agent/conversations/${session}/snapshot`)).json()

/** Entries as `kind: content`, one line per model message. */
const linesOf = (records: readonly Entry[]) =>
  records.flatMap((entry) => (entry.model ?? []).map((message) => `${entry.kind}: ${JSON.stringify(message.content)}`))

/** A conversation's history before entry `before`, through the route the Worker proxies (`/threads/<id>/history`). */
const historyOf = async (
  agent: DurableObjectStub<PersonalAgentProbe>,
  session: string,
  before = 2 ** 31,
): Promise<{ entries?: Entry[] }> =>
  (await agent.fetch(`https://agent/conversations/${session}/history?before=${before}`)).json()

/** A conversation's newest entries as people read them, in order, whatever the model's context starts with now. */
const transcript = async (agent: DurableObjectStub<PersonalAgentProbe>, session: string): Promise<string[]> =>
  linesOf((await historyOf(agent, session)).entries ?? [])

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
  await agent.submit(MAIN_THREAD, 'remember the word lantern', 'branch-main')
  await agent.settle(MAIN_THREAD, 'branch-main')
  const snapshot = await snapshotOf(agent, MAIN_THREAD)
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
    main: await transcript(agent, MAIN_THREAD),
    branch,
    request: await agent.requestFor('what was the word?'),
    forkedAt: answer?.id,
    before,
    afterOne,
    afterTwo: await listedThread(agent, thread.value.id),
  })
}

/** Reads every 20 ms, for up to 5 s, until `done` holds; the last read either way (background work settles late). */
async function until<A>(read: () => Promise<A>, done: (value: A) => boolean): Promise<A> {
  let value = await read()
  for (let attempt = 0; attempt < 250 && !done(value); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    value = await read()
  }
  return value
}

/** The agent's conversations, once `done` holds for them. */
const threadsUntil = (
  agent: DurableObjectStub<PersonalAgentProbe>,
  done: (views: readonly ConversationView[]) => boolean,
) =>
  until(async (): Promise<readonly ConversationView[]> => {
    const threads = await agent.conversations()
    return threads.ok ? threads.value : []
  }, done)

/**
 * A thread shares a note with main: main's next request carries it, labelled with the thread, and it started no run
 * of its own. Only the thread is offered `share_back`, and the thread is named after its first exchange. The thread
 * is branched, so main gets no note of its start (that is for threads started with "+": `announceSequence`).
 */
async function shareSequence(agent: DurableObjectStub<PersonalAgentProbe>): Promise<Response> {
  await agent.submit(MAIN_THREAD, 'remember the word lantern', 'share-main')
  await agent.settle(MAIN_THREAD, 'share-main')
  const answer = ((await historyOf(agent, MAIN_THREAD)).entries ?? []).findLast(({ kind }) => kind === 'pi.assistant')
  const thread = await branchMain(agent, answer?.id)
  if (!thread.ok) return Response.json({ thread })
  const share = 'call share_back {"note":"the word is lantern"}'
  await agent.submit(thread.value.id, share, 'share-thread')
  const shared = await agent.settle(thread.value.id, 'share-thread')
  await agent.submit(MAIN_THREAD, 'what did the thread say?', 'share-ask')
  await agent.settle(MAIN_THREAD, 'share-ask')
  return Response.json({
    shared,
    main: await transcript(agent, MAIN_THREAD),
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
    async () => (await transcript(agent, MAIN_THREAD)).filter((line) => line.startsWith('app.thread_started')),
    (notes) => notes.length >= count,
  )

/**
 * A thread started with "+" tells main its name, once, after its first exchange names it: main's model reads the
 * note, no run starts for it, and a second exchange or a branched thread adds none.
 */
async function announceSequence(agent: DurableObjectStub<PersonalAgentProbe>): Promise<Response> {
  await agent.submit(MAIN_THREAD, 'remember the word lantern', 'announce-main')
  await agent.settle(MAIN_THREAD, 'announce-main')
  const fresh = await agent.createConversation({})
  if (!fresh.ok) return Response.json({ fresh })
  await agent.submit(fresh.value.id, 'plan the trip', 'announce-thread')
  await agent.settle(fresh.value.id, 'announce-thread')
  const first = await notesUntil(agent, 1)
  await agent.submit(fresh.value.id, 'and the hotel?', 'announce-thread-again')
  await agent.settle(fresh.value.id, 'announce-thread-again')
  const answer = ((await historyOf(agent, MAIN_THREAD)).entries ?? []).findLast(({ kind }) => kind === 'pi.assistant')
  const branched = await branchMain(agent, answer?.id)
  if (!branched.ok) return Response.json({ branched })
  await agent.submit(branched.value.id, 'what was the word?', 'announce-branch')
  await agent.settle(branched.value.id, 'announce-branch')
  await threadsUntil(agent, (views) => views.some(({ id, title }) => id === branched.value.id && title))
  await agent.submit(MAIN_THREAD, 'which threads did I start?', 'announce-ask')
  await agent.settle(MAIN_THREAD, 'announce-ask')
  const mainEntries = (await historyOf(agent, MAIN_THREAD)).entries ?? []
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
  ((await snapshotOf(agent, MAIN_THREAD)).entries ?? []).findLast(({ kind }) => kind === 'pi.assistant')?.id

/** One owner message into a conversation, settled. */
async function exchange(agent: DurableObjectStub<PersonalAgentProbe>, session: string, text: string, id: string) {
  await agent.submit(session, text, id)
  return agent.settle(session, id)
}

/**
 * The owner's switches per conversation: main switches a tool and subagents off, a new thread (empty or branched)
 * copies that, the `subagent` tool leaves the request where subagents are off and comes back where they are turned on,
 * and Reset gives a thread main's switches again. Only what is shown can be switched off; main has no reset.
 */
async function capabilitySequence(agent: DurableObjectStub<PersonalAgentProbe>): Promise<Response> {
  await agent.seedNotes()
  const mainBefore = await agent.conversationCapabilities(MAIN_THREAD)
  await agent.setConversationCapability(MAIN_THREAD, {
    target: { kind: 'tool', serverId: 'notes', name: 'write' },
    on: false,
  })
  const mainAfter = await agent.setConversationCapability(MAIN_THREAD, { target: { kind: 'subagents' }, on: false })
  await exchange(agent, MAIN_THREAD, 'which tools do you have?', 'capabilities-main')
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
  const off = await exchange(agent, MAIN_THREAD, offCall, 'capabilities-off-call')
  const offResult = ((await historyOf(agent, MAIN_THREAD)).entries ?? []).findLast(
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
    unknown: await agent.setConversationCapability(MAIN_THREAD, {
      target: { kind: 'server', serverId: 'nope' },
      on: false,
    }),
    mainReset: await agent.setConversationCapability(MAIN_THREAD, { reset: 'parent' }),
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
 * its answer comes back into main as an input labelled with it, which main answers.
 */
async function subagentSequence(agent: DurableObjectStub<PersonalAgentProbe>): Promise<Response> {
  const spawn = `call subagent ${JSON.stringify({ action: 'spawn', name: 'scout', message: 'find the word' })}`
  await agent.submit(MAIN_THREAD, spawn, 'subagent-spawn')
  const spawned = await agent.settle(MAIN_THREAD, 'subagent-spawn')
  const main = await until(
    () => transcript(agent, MAIN_THREAD),
    (lines) =>
      lines.some((line) => line.includes('[from subagent')) && lines.at(-1)?.startsWith('pi.assistant') === true,
  )
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
  await exchange(agent, MAIN_THREAD, 'remember the word lantern', 'tree-main')
  const outer = await branchMain(agent, await mainAnswer(agent))
  if (!outer.ok) return Response.json({ outer })
  await exchange(agent, outer.value.id, 'what was the word?', 'tree-outer')
  const nested = await agent.createConversation({
    from: { conversation: outer.value.id, entry: await answerIn(agent, outer.value.id) },
  })
  if (!nested.ok) return Response.json({ nested })
  await exchange(agent, nested.value.id, 'and in the nested thread?', 'tree-nested')
  const spawn = `call subagent ${JSON.stringify({ action: 'spawn', name: 'digger', message: 'Native slow job' })}`
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
  const main = await agent.updateConversation(MAIN_THREAD, { closed: true })
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
  const spawn = `call subagent ${JSON.stringify({ action: 'spawn', name: 'scout', message: 'find the word' })}`
  await exchange(agent, MAIN_THREAD, spawn, 'subagent-branch-spawn')
  const listed = (await threadsUntil(agent, (views) => views.some(({ kind }) => kind === 'subagent'))).find(
    ({ kind }) => kind === 'subagent',
  )
  if (listed === undefined) return Response.json({ listed })
  await idle(agent, listed)
  const branch = await agent.createConversation({
    from: { conversation: listed.id, entry: await answerIn(agent, listed.id) },
  })
  if (!branch.ok) return Response.json({ branch })
  await exchange(agent, branch.value.id, 'what did you find?', 'subagent-branch-ask')
  const subagentAfter = (await agent.conversations()).ok ? await listedThread(agent, listed.id) : undefined
  const closed = await agent.updateConversation(listed.id, { closed: true })
  return Response.json({
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
    await agent.submit(MAIN_THREAD, input, operation)
    await agent.settle(MAIN_THREAD, operation)
  }
  const summarized = await until(
    async () => {
      const status = await agent.memoryStatus()
      return status.ok ? status.value.summarized : 0
    },
    (count) => count >= 2,
  )
  await agent.submit(MAIN_THREAD, 'what do you remember?', 'memory-3')
  await agent.settle(MAIN_THREAD, 'memory-3')
  await agent.submit(MAIN_THREAD, 'call zoom {"id":0,"n":1}', 'memory-4')
  const zoomed = await agent.settle(MAIN_THREAD, 'memory-4')
  const view = (await snapshotOf(agent, MAIN_THREAD)).entries?.[0]
  return Response.json({
    summarized,
    request: await agent.requestFor('what do you remember?'),
    zoomed,
    view: view?.kind,
    earlier: linesOf((await historyOf(agent, MAIN_THREAD, view?.head)).entries ?? []),
  })
}

/** Account deletion's agent half: state before, what the caller of deleteAgentData sees, state after. */
async function destroySequence(env: Env, name: string): Promise<Response> {
  const agent = env.AGENTS.getByName(name)
  await agent.residentSet(false)
  const submitted = await agent.submit(MAIN_THREAD, 'remember this before deletion', 'destroy-op-1')
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
    resident: await fresh.residentStatus(),
  })
}

function nativeFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const name = url.searchParams.get('name') ?? 'initialization'
  const agent = env.AGENTS.getByName(name)
  switch (url.pathname) {
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
    case '/memory':
      return memorySequence(agent)
    case '/binding':
      return agent.bindingProbe().then((result) => Response.json(result))
    default:
      return url.pathname.startsWith('/lifecycle') ? env.LIFECYCLE.getByName(name).fetch(request) : agent.fetch(request)
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === '/inbound-host') return inboundHostProbe(request)
    if (new URL(request.url).pathname.startsWith('/canonical'))
      return Promise.resolve(canonicalRedirect(request, 'https://purrable.lol') ?? Response.json({ canonical: true }))
    return nativeFetch(request, env)
  },
}
