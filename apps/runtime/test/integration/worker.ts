import { MAIN_THREAD, type ThreadView } from '@purrable/contracts'
import { PersonalAgent } from '../../src/agent.ts'
import { runApplicationMigrations } from '../../src/storage/migrations.ts'
import { listTables } from '../../src/storage/vendor.ts'
import * as Effect from 'effect/Effect'
import { AppMetadata } from '../../src/storage/metadata.ts'
import { Agent } from 'agents'
import { PiHarness } from 'agents/harness/pi'
import { createRegistry, Harness } from '@earendil-works/pi-durable'
import type { ProviderStreams } from '@earendil-works/pi-ai'
import { FIXTURE_INPUT, type SeenRequest, fixtureModels, model, scriptedStreams } from './model.ts'
import { nextInt } from 'effect/Random'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import { bindEndpoints } from '../../src/mcp/endpoints.ts'
import { AddedServerStore } from '../../src/mcp/servers.ts'
import { appMcpCredentials, appMcpEndpoints, appMcpGrants, appMcpOauthPending } from '../../src/storage/schema.ts'

const notesAt = (endpoint: string) => [{ serverId: 'notes', endpoint }]

/** The actual PersonalAgent on a scripted model (no network): every request it makes is kept for the test to read. */
export class PersonalAgentProbe extends PersonalAgent {
  readonly seen: SeenRequest[] = []

  protected override modelStreams(): ProviderStreams {
    return scriptedStreams((request) => this.seen.push(request))
  }

  /** Waits for an operation in a conversation to settle (the owner API has no wait route). */
  async settle(session: string, operationId: string) {
    return this.harness.wait(operationId, { session })
  }

  /**
   * The newest model request that answered `turn` (its last non-system message), as plain data: deep readonly types
   * do not cross the RPC stub. Matching the turn keeps the cheap model's own requests (thread titles) out of it.
   */
  requestFor(turn: string): { messages: { role: string; text: string }[]; tools: string[] } | undefined {
    const request = this.seen.findLast(
      ({ messages }) => messages.findLast((message) => message.role !== 'system')?.text === turn,
    )
    if (request === undefined) return undefined
    return { messages: request.messages.map(({ role, text }) => ({ role, text })), tools: [...request.tools] }
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
  const thread = await agent.createThread()
  const threads = await agent.threads()
  const badBranch = await agent.createThread(999_999)
  const unknownThread = await agent.submit('424242', 'hello', 'op-unknown-thread')
  const archived = thread.ok ? await agent.updateThread(thread.value.id, { archived: true }) : thread
  const mainUntouchable = await agent.updateThread(MAIN_THREAD, { title: 'renamed' })
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
    archived,
    mainUntouchable,
    usage,
    model: modelChoice,
    unknownModel,
    askWhileRevoked,
  })
}

const entries = async (agent: DurableObjectStub<PersonalAgentProbe>): Promise<number> => {
  const body: { snapshot?: { entries?: unknown[] } } = await (await agent.fetch('https://agent/probe')).json()
  return body.snapshot?.entries?.length ?? -1
}

type Entry = { readonly id: number; readonly kind: string; readonly model?: readonly { readonly content?: unknown }[] }

/** A conversation's snapshot through the same route the Worker proxies (`/threads/<id>/snapshot`). */
const snapshotOf = async (
  agent: DurableObjectStub<PersonalAgentProbe>,
  session: string,
): Promise<{ entries?: Entry[] }> => (await agent.fetch(`https://agent/threads/${session}/snapshot`)).json()

/** The text of a conversation's entries the model sees, in order: `kind: text`. */
async function transcript(agent: DurableObjectStub<PersonalAgentProbe>, session: string): Promise<string[]> {
  const snapshot = await snapshotOf(agent, session)
  return (snapshot.entries ?? []).flatMap((entry) =>
    (entry.model ?? []).map((message) => `${entry.kind}: ${JSON.stringify(message.content)}`),
  )
}

/**
 * A thread branched at main's answer sees main up to there and goes on alone: main never sees the thread's turn, and
 * the thread's request carried main's history.
 */
async function branchSequence(agent: DurableObjectStub<PersonalAgentProbe>): Promise<Response> {
  await agent.submit(MAIN_THREAD, 'remember the word lantern', 'branch-main')
  await agent.settle(MAIN_THREAD, 'branch-main')
  const snapshot = await snapshotOf(agent, MAIN_THREAD)
  const answer = (snapshot.entries ?? []).findLast((entry) => entry.kind === 'pi.assistant')
  const thread = await agent.createThread(answer?.id)
  if (!thread.ok) return Response.json({ thread })
  await agent.submit(thread.value.id, 'what was the word?', 'branch-thread')
  const settled = await agent.settle(thread.value.id, 'branch-thread')
  return Response.json({
    thread: thread.value,
    settled,
    main: await transcript(agent, MAIN_THREAD),
    branch: await transcript(agent, thread.value.id),
    request: await agent.requestFor('what was the word?'),
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
const threadsUntil = (agent: DurableObjectStub<PersonalAgentProbe>, done: (views: readonly ThreadView[]) => boolean) =>
  until(async (): Promise<readonly ThreadView[]> => {
    const threads = await agent.threads()
    return threads.ok ? threads.value : []
  }, done)

/**
 * A thread shares a note with main: main's next request carries it, labelled with the thread, and it started no run
 * of its own. Only the thread is offered `share_to_main`, and the thread is named after its first exchange.
 */
async function shareSequence(agent: DurableObjectStub<PersonalAgentProbe>): Promise<Response> {
  await agent.submit(MAIN_THREAD, 'remember the word lantern', 'share-main')
  await agent.settle(MAIN_THREAD, 'share-main')
  const thread = await agent.createThread()
  if (!thread.ok) return Response.json({ thread })
  const share = 'call share_to_main {"note":"the word is lantern"}'
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
  const subagent = (
    await threadsUntil(agent, (views) => views.some(({ kind, busy }) => kind === 'subagent' && !busy))
  ).find(({ kind }) => kind === 'subagent')
  return Response.json({
    spawned,
    main,
    subagent,
    child: subagent === undefined ? [] : await transcript(agent, subagent.id),
    mainRequest: await agent.requestFor(spawn),
    childRequest: await agent.requestFor('find the word'),
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

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const name = new URL(request.url).searchParams.get('name') ?? 'initialization'
    if (new URL(request.url).pathname === '/rpc') return rpcSequence(env.AGENTS.getByName(name))
    if (new URL(request.url).pathname === '/destroy') return destroySequence(env, name)
    if (new URL(request.url).pathname === '/branch') return branchSequence(env.AGENTS.getByName(name))
    if (new URL(request.url).pathname === '/share') return shareSequence(env.AGENTS.getByName(name))
    if (new URL(request.url).pathname === '/subagent') return subagentSequence(env.AGENTS.getByName(name))
    if (new URL(request.url).pathname === '/binding')
      return env.AGENTS.getByName(name)
        .bindingProbe()
        .then((result) => Response.json(result))
    if (new URL(request.url).pathname.startsWith('/lifecycle')) return env.LIFECYCLE.getByName(name).fetch(request)
    return env.AGENTS.getByName(name).fetch(request)
  },
}
