import { PersonalAgent } from '../../src/agent.ts'
import { runApplicationMigrations } from '../../src/storage/migrations.ts'
import { listTables } from '../../src/storage/vendor.ts'
import * as Effect from 'effect/Effect'
import { AppMetadata } from '../../src/storage/metadata.ts'
import { Agent } from 'agents'
import { PiHarness } from 'agents/harness/pi'
import { createRegistry, Harness } from '@earendil-works/pi-durable'
import { FIXTURE_INPUT, fixtureModels, model } from './model.ts'
import { nextInt } from 'effect/Random'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import { bindEndpoints } from '../../src/mcp/endpoints.ts'
import { AddedServerStore } from '../../src/mcp/servers.ts'
import { appMcpCredentials, appMcpEndpoints, appMcpGrants, appMcpOauthPending } from '../../src/storage/schema.ts'

const notesAt = (endpoint: string) => [{ serverId: 'notes', endpoint }]

/** Actual PersonalAgent startup, with no model generation or external calls in this storage test. */
export class PersonalAgentProbe extends PersonalAgent {
  override async onRequest(): Promise<Response> {
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
    return Response.json({ snapshot: await this.sessionSnapshot(), before, after, metadata })
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
  const noConversation = await agent.clientMessages('client-1', 5)
  const usage = await agent.usageToday()
  const modelChoice = await agent.modelChoice()
  const unknownModel = await agent.chooseModel('not-offered')
  await agent.residentSet(false)
  const askWhileRevoked = await agent.askAsClient('client-1', 'Test client', 'hello', 'op-1', 1000)
  return Response.json({
    first,
    revoked,
    afterOwnerRequest,
    enabled,
    servers,
    unknownServer,
    unknownApp,
    noConversation,
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

/** Account deletion's agent half: state before, what the caller of deleteAgentData sees, state after. */
async function destroySequence(env: Env, name: string): Promise<Response> {
  const agent = env.AGENTS.getByName(name)
  await agent.residentSet(false)
  const submitted = await agent.submit('remember this before deletion', 'destroy-op-1')
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
    if (new URL(request.url).pathname === '/binding')
      return env.AGENTS.getByName(name)
        .bindingProbe()
        .then((result) => Response.json(result))
    if (new URL(request.url).pathname.startsWith('/lifecycle')) return env.LIFECYCLE.getByName(name).fetch(request)
    return env.AGENTS.getByName(name).fetch(request)
  },
}
