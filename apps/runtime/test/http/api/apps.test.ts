import { AppView, type AgentAppLaunch } from '@goblin/contracts'
import { AgentAppsGroup, AppsGroup, NotFound } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { AgentAppsHandlers } from '../../../src/agent-apps/api.ts'
import type { AppDetail, AppSummary } from '../../../src/agent-apps/manage.ts'
import { AppEngine } from '../../../src/agent-apps/service.ts'
import { AppsHandlers } from '../../../src/apps/api.ts'
import type { AppOrigin } from '../../../src/apps/registry.ts'
import { Apps } from '../../../src/apps/service.ts'
import { Conversations } from '../../../src/chats/service.ts'
import { Home } from '../../../src/home/service.ts'
import { McpConnections, Resident } from '../../../src/mcp/service.ts'
import type { McpConnectionSnapshot } from '../../../src/mcp/types.ts'
import { callOwner } from '../../owner-client.ts'
import { currentResident, json, plans, post, serve, served, stub, unrouted } from './fixture.ts'

/** `Apps` with `overrides`; any other member dies when used, so a test names every call it expects. */
const fakeApps = (overrides: Partial<Apps['Service']> = {}) => stub(Apps, overrides)

/** `AppEngine` with `overrides`; any other member dies when used. */
const fakeEngine = (overrides: Partial<AppEngine['Service']> = {}) => stub(AppEngine, overrides)

/** Other lanes' services the programs read, as the parts a test uses; the rest is never touched. */
type OtherParts = {
  readonly conversations?: Pick<Conversations['Service'], 'require' | 'requireOpen' | 'kindOf'>
  readonly connections?: Pick<McpConnections['Service'], 'connect'>
  readonly home?: Pick<Home['Service'], 'appRemoved'>
}

/**
 * The apps and agentApps groups behind the real owner gate, over `apps` and `engine` and the other parts given. The
 * gate's plan and resident authority are the only other fakes.
 */
function appsServer(
  options: {
    readonly apps?: Layer.Layer<Apps>
    readonly engine?: Layer.Layer<AppEngine>
    readonly others?: OtherParts
    readonly active?: boolean
  } = {},
) {
  const resident = currentResident()
  const others = options.others ?? {}
  const { fetch } = serve(
    served([AppsGroup, AgentAppsGroup], Layer.mergeAll(AppsHandlers, AgentAppsHandlers)).pipe(
      Layer.provide(
        Layer.mergeAll(
          options.apps ?? fakeApps(),
          options.engine ?? fakeEngine(),
          // The programs under test call only the members `OtherParts` names.
          stub(Conversations, others.conversations),
          stub(McpConnections, others.connections),
          stub(Home, others.home),
          Layer.succeed(Resident, resident.service),
          plans(options.active),
        ),
      ),
    ),
  )
  return { fetch, resident }
}

const BOARD = 'ui://fixture/board'

const kept: AppView = {
  id: '3',
  conversation: '7',
  title: 'Board',
  createdAt: 100,
  source: { kind: 'mcp', callId: 'call-1', connectionId: 'fixture', tool: 'board', uri: BOARD },
}

/** The fixture server as the host connects to it now: one tool, `board`, rendering `uri` when it is given. */
const connected = (uri?: string): McpConnectionSnapshot => ({
  config: { connectionId: 'fixture', endpoint: 'https://fixture.test/mcp' },
  capabilities: {},
  tools: [
    {
      name: 'board',
      title: 'Board',
      inputSchema: { type: 'object' },
      ...(uri === undefined ? {} : { _meta: { ui: { resourceUri: uri } } }),
    },
  ],
  resources: [],
  resourceTemplates: [],
  prompts: [],
})

/** The App registry for one kept MCP App: its call in conversation 7, and closing or reopening it. */
const registry = (registered: { session: string; callId: string; origin: AppOrigin }[] = []) =>
  fakeApps({
    call: (session, callId) =>
      session === 'session-7' && callId === 'call-1'
        ? Effect.succeed({
            entry: 4,
            connectionId: 'fixture',
            tool: 'board',
            arguments: { marker: 'kept' },
            result: null,
          })
        : Effect.fail(new NotFound({ what: 'app call' })),
    register: (session, callId, origin) =>
      Effect.sync(() => {
        registered.push({ session, callId, origin })
        return kept
      }),
    update: (id, closed) =>
      id === kept.id
        ? Effect.succeed(closed ? { ...kept, closedAt: 200 } : kept)
        : Effect.fail(new NotFound({ what: 'app' })),
  })

const conversations = {
  require: (id: string) => Effect.succeed(`session-${id}`),
  requireOpen: (id: string) => Effect.succeed(id),
  kindOf: () => Effect.succeed('main' as const),
}

describe('the apps group served by the agent', () => {
  it('keeps the App of a call with 201 while its tool still renders it, and 404 once it does not', async () => {
    const registered: { session: string; callId: string; origin: AppOrigin }[] = []
    let uri: string | undefined = BOARD
    const { fetch, resident } = appsServer({
      apps: registry(registered),
      others: { conversations, connections: { connect: () => Effect.sync(() => connected(uri)) } },
    })
    const made = await fetch(post('/api/apps', { conversation: '7', callId: 'call-1' }))
    expect(made.status).toBe(201)
    expect(Schema.decodeUnknownSync(AppView)(await made.json())).toEqual(kept)
    expect(registered.at(-1)).toEqual({
      session: 'session-7',
      callId: 'call-1',
      origin: { connectionId: 'fixture', tool: 'board', uri: BOARD, title: 'Board' },
    })
    expect(resident.renewals).toHaveLength(1)
    uri = undefined
    const gone = await fetch(post('/api/apps', { conversation: '7', callId: 'call-1' }, { 'x-goblin-ref': 'r' }))
    expect(gone.status).toBe(404)
    expect(await gone.json()).toMatchObject({ error: { code: 'not_found', what: 'app', ref: 'r' } })
  })

  it('closes an App and opens it again; an unknown one is the 404 envelope with the reference', async () => {
    const { fetch } = appsServer({ apps: registry() })
    const closed = await fetch(json('PATCH', '/api/apps/3', { closed: true }))
    expect(closed.status).toBe(200)
    expect(await closed.json()).toEqual({ ...kept, closedAt: 200 })
    expect(await (await fetch(json('PATCH', '/api/apps/3', { closed: false }))).json()).toEqual(kept)
    const unknown = await fetch(json('PATCH', '/api/apps/9', { closed: true }, { 'x-goblin-ref': 'ref-404' }))
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toEqual({
      error: { code: 'not_found', message: 'That does not exist.', what: 'app', ref: 'ref-404' },
    })
  })

  it("serves an agent app's view: its launch, its state, an action call with its op and a kept failure", async () => {
    const launch: AgentAppLaunch = {
      kind: 'agent',
      name: 'tally',
      release: 'r1',
      revision: 2,
      state: { count: 2 },
      ui: { module: 'export default 1', css: '', libs: ['charts'] },
    }
    const calls: unknown[][] = []
    const { fetch } = appsServer({
      apps: fakeApps({
        launch: () => Effect.succeed(launch),
        agentApp: (id) => (id === '5' ? Effect.succeed('tally') : Effect.fail(new NotFound({ what: 'agent app' }))),
      }),
      engine: fakeEngine({
        snapshot: () => Effect.succeed({ revision: 2, release: 'r1', state: { count: 2 } }),
        viewCall: (...call) =>
          Effect.sync(() => {
            calls.push(call)
            return { ok: true as const, revision: 3, release: 'r1', state: { count: 3 } }
          }),
        viewError: (_name, message) => Effect.succeed({ kept: message.length > 0 }),
      }),
    })
    expect(await (await fetch(json('GET', '/api/apps/5/launch'))).json()).toEqual(launch)
    expect(await (await fetch(json('GET', '/api/apps/5/state'))).json()).toEqual({
      revision: 2,
      release: 'r1',
      state: { count: 2 },
    })
    const op = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f'
    const called = await fetch(post('/api/apps/5/call', { name: 'tap', arguments: { by: 1 }, op }))
    expect(called.status).toBe(200)
    expect(await called.json()).toEqual({ ok: true, revision: 3, release: 'r1', state: { count: 3 } })
    expect(calls).toEqual([['tally', 'tap', { by: 1 }, op]])
    const reported = await fetch(post('/api/apps/5/diagnostics', { message: 'TypeError: x' }))
    expect(await reported.json()).toEqual({ kept: true })
    expect((await fetch(json('GET', '/api/apps/6/state'))).status).toBe(404)
  })

  it('answers a path id that is not one as 404 and a body that does not fit as 400, as the routes did', async () => {
    const { fetch } = appsServer({ apps: registry() })
    const badId = await fetch(json('GET', '/api/apps/abc/launch'))
    expect(badId.status).toBe(404)
    expect(await badId.json()).toMatchObject({ error: { code: 'not_found', what: 'route' } })
    for (const [method, path, body] of [
      ['PATCH', '/api/apps/3', { closed: 'yes' }],
      ['POST', '/api/apps', { conversation: 'seven', callId: 'call-1' }],
      ['POST', '/api/apps/3/call', { name: 'tap', arguments: {}, op: 'not-an-op' }],
      ['POST', '/api/apps/3/diagnostics', { message: 'x'.repeat(4001) }],
    ] as const) {
      const response = await fetch(json(method, path, body))
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: 'invalid_input' } })
    }
    for (const request of [json('GET', '/api/apps/3'), json('DELETE', '/api/apps/3'), json('GET', '/api/apps')])
      expect(await unrouted(await fetch(request))).toBe(true)
  })

  it("serves the probes' typed client: an unknown App decodes as the NotFound class with its reference", async () => {
    const { fetch } = appsServer({ apps: registry() })
    const agent = { fetch }
    const closed = await callOwner(agent, (api) => api.apps.update({ params: { id: '3' }, payload: { closed: true } }))
    expect(closed).toEqual({ ...kept, closedAt: 200 })
    const missing = await callOwner(agent, (api) =>
      Effect.flip(api.apps.update({ params: { id: '9' }, payload: { closed: true } })),
    )
    expect(missing).toMatchObject({ _tag: 'NotFound', what: 'app', ref: 'integration-probe' })
  })
})

const tally: AppSummary = {
  name: 'tally',
  title: 'Tally',
  description: 'Counts.',
  home: '7',
  version: 2,
  revision: 3,
  jobs: [],
  waiting: 0,
  failure: null,
  updatedAt: 500,
}
const notes: AppSummary = { ...tally, name: 'notes', title: 'Notes', updatedAt: 400 }

const detail: AppDetail = {
  ...tally,
  releases: [{ release: 'r2', version: 2, status: 'active', note: null, at: 500 }],
  powers: [{ kind: 'egress', target: 'example.com', status: 'pending' }],
  usage: { egress: 1, tokens: 0, notify: 0, job: 0 },
  files: { count: 0, bytes: 0 },
  events: [],
}

/** The engine with `tally` and `notes`, and the App registry where only `tally` has a view (App 5); calls are kept. */
const agentApps = (seen: string[] = []) => ({
  apps: fakeApps({
    agentId: (name) => Effect.succeed(name === 'tally' ? '5' : null),
    removeAgent: (name) => Effect.sync(() => void seen.push(`apps.removeAgent ${name}`)),
  }),
  engine: fakeEngine({
    summaries: Effect.succeed([tally, notes]),
    detail: (name) => (name === 'tally' ? Effect.succeed(detail) : Effect.fail(new NotFound({ what: `app ${name}` }))),
    change: (name, change) => Effect.sync(() => void seen.push(`engine.change ${name} ${change.kind}`)),
    moveHome: (name, session) => Effect.sync(() => void seen.push(`engine.moveHome ${name} ${session}`)),
    remove: (name) => Effect.sync(() => void seen.push(`engine.remove ${name}`)),
  }),
  others: {
    conversations: {
      require: (id: string) => Effect.succeed(id),
      requireOpen: (id: string) => Effect.succeed(id),
      kindOf: (id: string) => Effect.succeed(id === '8' ? ('subagent' as const) : ('main' as const)),
    },
    home: { appRemoved: Effect.sync(() => void seen.push('home.appRemoved')) },
  },
})

describe('the agentApps group served by the agent', () => {
  it('lists the agent apps with their App ids, newest change first, and reads one in full', async () => {
    const { fetch, resident } = appsServer(agentApps())
    const listed = await fetch(json('GET', '/api/agent-apps'))
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual([
      { ...tally, app: '5' },
      { ...notes, app: null },
    ])
    expect(await (await fetch(json('GET', '/api/agent-apps/tally'))).json()).toEqual({ ...detail, app: '5' })
    const ghost = await fetch(json('GET', '/api/agent-apps/ghost', undefined, { 'x-goblin-ref': 'ref-404' }))
    expect(ghost.status).toBe(404)
    expect(await ghost.json()).toMatchObject({ error: { code: 'not_found', what: 'app ghost', ref: 'ref-404' } })
    expect(resident.renewals).toHaveLength(3)
  })

  it("applies a change and answers with the app after it; a new home is the owner's main or a thread", async () => {
    const seen: string[] = []
    const { fetch } = appsServer(agentApps(seen))
    const paused = await fetch(post('/api/agent-apps/tally', { kind: 'pause', action: 'tick', paused: true }))
    expect(paused.status).toBe(200)
    expect(await paused.json()).toEqual({ ...detail, app: '5' })
    const subagent = await fetch(post('/api/agent-apps/tally', { kind: 'home', conversation: '8' }))
    expect(subagent.status).toBe(400)
    expect(await subagent.json()).toMatchObject({
      error: { code: 'invalid_input', reason: "an app's home is main or a thread" },
    })
    expect((await fetch(post('/api/agent-apps/tally', { kind: 'home', conversation: '9' }))).status).toBe(200)
    expect((await fetch(post('/api/agent-apps/tally', { kind: 'explode' }))).status).toBe(400)
    expect(seen).toEqual(['engine.change tally pause', 'engine.moveHome tally 9'])
  })

  it('deletes one only once its name is typed: its engine rows, its App, then Home is told', async () => {
    const seen: string[] = []
    const { fetch } = appsServer(agentApps(seen))
    const refused = await fetch(json('DELETE', '/api/agent-apps/tally', { confirm: 'nope' }))
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: { code: 'invalid_input', reason: 'type tally to delete it' } })
    expect(seen).toEqual([])
    const deleted = await fetch(json('DELETE', '/api/agent-apps/tally', { confirm: 'tally' }))
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ deleted: 'tally' })
    expect(seen).toEqual(['engine.remove tally', 'apps.removeAgent tally', 'home.appRemoved'])
  })

  it('answers a name that is not one as 404, and any other method as no route', async () => {
    const { fetch } = appsServer(agentApps())
    const bad = await fetch(json('GET', '/api/agent-apps/Bad_Name'))
    expect(bad.status).toBe(404)
    expect(await bad.json()).toMatchObject({ error: { code: 'not_found', what: 'route' } })
    for (const request of [json('PUT', '/api/agent-apps/tally', {}), post('/api/agent-apps', {})])
      expect(await unrouted(await fetch(request))).toBe(true)
  })

  it("serves the probes' typed client: a refused delete decodes as the InvalidInput class", async () => {
    const { fetch } = appsServer(agentApps())
    const agent = { fetch }
    expect(await callOwner(agent, (api) => api.agentApps.list())).toHaveLength(2)
    const refused = await callOwner(agent, (api) =>
      Effect.flip(api.agentApps.delete({ params: { name: 'tally' }, payload: { confirm: 'tal' } })),
    )
    expect(refused).toMatchObject({ _tag: 'InvalidInput', reason: 'type tally to delete it' })
  })
})
