import { createMcpHandler } from '@modelcontextprotocol/server'
import { type ApprovalView, Grant, ServerView, ToolView } from '@goblin/contracts'
import { McpGroup } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { NotFound } from '../../../src/http/errors.ts'
import { ResidentLive } from '../../../src/layers/core.ts'
import { McpHandlers } from '../../../src/mcp/api.ts'
import { mcpHost } from '../../../src/mcp/host.ts'
import { Approvals, Events } from '../../../src/mcp/service.ts'
import { SingleFlight } from '../../../src/observability/single-flight.ts'
import { AgentInput, type AgentInputs } from '../../../src/runtime/input.ts'
import { Apps } from '../../../src/apps/service.ts'
import { Budget } from '../../../src/budget.ts'
import { Capabilities } from '../../../src/capabilities/service.ts'
import { ChatOperations, Chats, Conversations } from '../../../src/chats/service.ts'
import { Files } from '../../../src/files/service.ts'
import { Invocations, Personas } from '../../../src/personas/service.ts'
import { PiSessions } from '../../../src/pi/sessions.ts'
import { RoutineControl, RoutineRuns, RoutineUsage } from '../../../src/routines/service.ts'
import { Skills } from '../../../src/skills/service.ts'
import { MemoryAddedServers, MemoryCredentials, MemoryGrants, MemoryRegistries } from '../../mcp/memory.ts'
import { callOwner } from '../../owner-client.ts'
import { database, get, json, plans, post, serve, served, sqliteDb, stub } from './fixture.ts'
import { lowLevelServer } from '../../mcp/low-level-server.ts'

const BOARD = 'ui://notes/board.html'

/**
 * A notes server: `open` renders the board App (offered to the model), `move` is the App's own, `delete` stands alone.
 * A call answers content, structured content and fields this contract does not name, which must reach the owner whole.
 */
const notes = createMcpHandler(() => {
  const server = lowLevelServer({ name: 'notes', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler('tools/list', () => ({
    tools: [
      { name: 'open', inputSchema: { type: 'object', properties: {} }, _meta: { ui: { resourceUri: BOARD } } },
      {
        name: 'move',
        inputSchema: { type: 'object', properties: {} },
        _meta: { ui: { resourceUri: BOARD, visibility: ['app'] } },
      },
      { name: 'delete', inputSchema: { type: 'object', properties: {} } },
    ],
  }))
  server.setRequestHandler('tools/call', (request) => ({
    content: [{ type: 'text', text: `called ${request.params.name}` }],
    structuredContent: { tool: request.params.name },
    _meta: { 'notes/board': 'v1' },
  }))
  return server
})

const VIEW: ApprovalView = {
  id: 'mcp:7:call-1',
  serverId: 'notes',
  name: 'delete',
  arguments: { accessToken: '[redacted]' },
  state: 'pending',
  expiresAt: 1,
}

/**
 * The mcp group over a real MCP host (memory stores, the notes server above) through the wave 1 adapters, real resident
 * authority on SQLite for the gate, and fakes for Events and held calls that record what reached them. Settling a held
 * call, skills and the services an owner message reaches are not exercised here (`approvals-case` covers them natively).
 */
const fixture = async () => {
  const db = database()
  const credentials = new MemoryCredentials()
  await credentials.saveTokens('notes', { access_token: 'fixture-token', token_type: 'bearer' }, 0)
  const grants = new MemoryGrants()
  /** The notes server at `/mcp`; every other request (a server card, a registry) finds nothing. */
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    return new URL(request.url).pathname === '/mcp' ? notes.fetch(request) : new Response(null, { status: 404 })
  }
  const host = mcpHost({
    servers: [{ serverId: 'notes', endpoint: 'https://notes.test/mcp' }],
    credentials,
    grants,
    added: new MemoryAddedServers(credentials, grants),
    registries: new MemoryRegistries(),
    appUrl: 'https://goblin.test',
    fetch: fetcher,
  })
  const disabled: (string | undefined)[] = []
  const events = stub(Events, {
    health: () => Effect.succeed([]),
    disableServer: (serverId?: string) => Effect.sync(() => void disabled.push(serverId)),
  })
  const approvals = stub(Approvals, {
    view: (id: string) => (id === VIEW.id ? Effect.succeed(VIEW) : Effect.fail(new NotFound({ what: 'MCP approval' }))),
  })
  // SAFETY: the mcp handlers read only `env.STAGE` (suggested servers) here.
  const input = { env: { STAGE: 'test' } } as AgentInputs
  const { fetch } = serve(
    served([McpGroup], McpHandlers).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mergeAll(host.pipe(Layer.provide(SingleFlight.layer)), Layer.succeed(AgentInput, input), sqliteDb(db)),
          events,
          approvals,
          ResidentLive.pipe(Layer.provide(sqliteDb(db))),
          plans(),
          // Settling a held call, skills and an owner message (agent-program.ts sendOwnerMessage) read these; no test
          // here reaches them.
          Layer.mergeAll(stub(ChatOperations), stub(Skills), stub(Chats), stub(RoutineRuns), stub(Apps), stub(Budget)),
          Layer.mergeAll(stub(Capabilities), stub(Conversations), stub(Files), stub(Invocations), stub(Personas)),
          stub(PiSessions),
          stub(RoutineControl),
          stub(RoutineUsage),
        ),
      ),
    ),
  )
  return { fetch, grants, disabled }
}

const decodeServers = Schema.decodeUnknownSync(Schema.Array(ServerView))
const decodeGrants = Schema.decodeUnknownSync(Schema.Array(Grant))
const decodeTools = Schema.decodeUnknownSync(Schema.Array(ToolView))

describe('the mcp group', () => {
  it('lists the servers with their Events health, and the built-in registries', async () => {
    const { fetch } = await fixture()
    const servers = await fetch(get('/api/mcp/servers'))
    expect(servers.status).toBe(200)
    expect(decodeServers(await servers.json())).toEqual([
      expect.objectContaining({ serverId: 'notes', status: 'connected', source: 'config', eventHealth: [] }),
    ])
    const registries = await (await fetch(get('/api/mcp/registries'))).json()
    expect(registries).toEqual([
      expect.objectContaining({ title: 'MCP Registry', builtIn: true }),
      expect.objectContaining({ title: 'GitHub MCP Registry', builtIn: true }),
    ])
    expect((await fetch(get('/api/mcp/suggested'))).status).toBe(200)
  })

  it('grants a tool with its App resource, shows it on the tool, and revokes it again', async () => {
    const { fetch } = await fixture()
    const granted = await fetch(json('PUT', '/api/mcp/grants', { serverId: 'notes', name: 'open', allowed: true }))
    expect(granted.status).toBe(200)
    expect(decodeGrants(await granted.json()).map(({ capability, name }) => `${capability}:${name}`)).toEqual([
      'tool:open',
      `resource:${BOARD}`,
    ])
    const tools = decodeTools(await (await fetch(get('/api/mcp/notes/tools?refresh'))).json())
    expect(tools.find((tool) => tool.name === 'open')).toMatchObject({ granted: true, appResource: BOARD })
    expect(tools.find((tool) => tool.name === 'delete')).toMatchObject({ granted: false })
    const revoked = await fetch(json('PUT', '/api/mcp/grants', { serverId: 'notes', name: 'open', allowed: false }))
    expect(await revoked.json()).toEqual([])
  })

  it('answers what names nothing as 404 and a query or body out of bounds as 400', async () => {
    const { fetch } = await fixture()
    const missing = await fetch(json('PUT', '/api/mcp/grants', { serverId: 'notes', name: 'absent', allowed: true }))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: 'not_found', what: 'tool absent' } })
    const unknown = await fetch(json('PUT', '/api/mcp/app-grants', { serverId: 'nope', uri: BOARD, allowed: true }))
    expect(unknown.status).toBe(404)
    for (const path of ['/api/mcp/not.a.server/tools', '/api/mcp/approvals/has%20space'])
      expect(await (await fetch(get(path))).json()).toMatchObject({ error: { code: 'not_found', what: 'route' } })
    // No registry answers here, so the search says it is partial rather than that nothing matched.
    expect(await (await fetch(get('/api/mcp/catalog?q=notes'))).json()).toEqual({ entries: [], partial: true })
    const long = await fetch(get(`/api/mcp/catalog?q=${'x'.repeat(101)}`))
    expect(long.status).toBe(400)
    expect(await long.json()).toMatchObject({ error: { code: 'invalid_input', reason: 'query_too_long' } })
    const notUi = await fetch(
      json('PUT', '/api/mcp/app-grants', { serverId: 'notes', uri: 'https://x', allowed: true }),
    )
    expect(notUi.status).toBe(400)
  })

  it('calls a granted tool by hand and answers the remote result whole; an App may call only what it is offered', async () => {
    const { fetch } = await fixture()
    await fetch(json('PUT', '/api/mcp/app-grants', { serverId: 'notes', uri: BOARD, allowed: true }))
    const called = await fetch(post('/api/mcp/notes/tools/call', { name: 'open' }))
    expect(called.status).toBe(200)
    // `_meta` is a field the contract does not name: it reaches the owner as the server (and the SDK) sent it.
    expect(await called.json()).toMatchObject({
      content: [{ type: 'text', text: 'called open' }],
      structuredContent: { tool: 'open' },
      _meta: { 'notes/board': 'v1' },
    })
    const app = await fetch(post('/api/mcp/notes/tools/call', { name: 'move' }, { 'x-mcp-caller': 'app' }))
    expect(await app.json()).toMatchObject({ structuredContent: { tool: 'move' } })
    const ungranted = await fetch(post('/api/mcp/notes/tools/call', { name: 'delete', arguments: {} }))
    expect(ungranted.status).toBe(403)
    expect(await ungranted.json()).toMatchObject({ error: { code: 'grant_denied', serverId: 'notes', name: 'delete' } })
  })

  it('shows a held call, and disconnects a server after its Events subscriptions', async () => {
    const { fetch, disabled } = await fixture()
    const held = await fetch(get(`/api/mcp/approvals/${encodeURIComponent(VIEW.id)}`))
    expect(held.status).toBe(200)
    expect(await held.json()).toEqual(VIEW)
    expect((await fetch(get('/api/mcp/approvals/mcp:7:other'))).status).toBe(404)
    const disconnected = await fetch(post('/api/mcp/notes/disconnect', {}))
    expect(disconnected.status).toBe(200)
    expect(await disconnected.json()).toBeNull()
    expect(disabled).toEqual(['notes'])
    const servers = decodeServers(await (await fetch(get('/api/mcp/servers'))).json())
    expect(servers[0]?.status).toBe('disconnected')
  })

  it("serves the probes' typed client: a missing tool decodes as NotFound, an ungranted call as GrantDenied", async () => {
    const { fetch } = await fixture()
    const agent = { fetch }
    expect(await callOwner(agent, (api) => api.mcp.servers())).toEqual([expect.objectContaining({ serverId: 'notes' })])
    const failure = await callOwner(agent, (api) =>
      Effect.flip(api.mcp.setToolGrant({ payload: { serverId: 'notes', name: 'absent', allowed: true } })),
    )
    expect(failure).toMatchObject({ _tag: 'NotFound', what: 'tool absent', ref: 'integration-probe' })
    const denied = await callOwner(agent, (api) =>
      Effect.flip(api.mcp.callTool({ params: { id: 'notes' }, headers: {}, payload: { name: 'open' } })),
    )
    expect(denied).toMatchObject({ _tag: 'GrantDenied', serverId: 'notes', name: 'open' })
  })
})
