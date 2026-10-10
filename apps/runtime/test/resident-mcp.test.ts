import { EVERYTHING, type TopicSetup } from '@goblin/contracts'
import { createMcpHandler } from '@modelcontextprotocol/server'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { describe, expect, it } from 'vitest'
import type { AppError } from '../src/http/errors.ts'
import { mcpHost } from '../src/mcp/host.ts'
import { type CapabilityScope, type Exclusion, scopeOf, topicScope } from '../src/capabilities/profiles.ts'
import { Capabilities } from '../src/capabilities/service.ts'
import { residentMcpExtension } from '../src/pi/resident-mcp.ts'
import { Resident } from '../src/mcp/service.ts'
import { RoutineRuns } from '../src/routines/service.ts'
import { SingleFlight } from '../src/observability/single-flight.ts'
import { AgentInput, type AgentInputs } from '../src/runtime/input.ts'
import type { AgentServices } from '../src/layers/index.ts'
import { chatDatabase } from './chats-sqlite.ts'
import { FixedProfiles } from './fixed-services.ts'
import { plans, sqliteDb, stub } from './http/api/fixture.ts'
import { MemoryCredentials, MemoryGrants, MemoryRegistries } from './mcp/memory.ts'
import { lowLevelServer } from './mcp/low-level-server.ts'
import { executeTool, inConversation } from './pi-tool.ts'

/** The tools the notes server ran, in order. */
const ran: string[] = []

/** A notes server: `read` is granted, `write` exists but is not, `panel` is for its App only. */
const notes = createMcpHandler(() => {
  const server = lowLevelServer({ name: 'notes', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler('tools/list', () => ({
    tools: [
      { name: 'read', inputSchema: { type: 'object', properties: {} } },
      { name: 'write', inputSchema: { type: 'object', properties: {} } },
      { name: 'panel', inputSchema: { type: 'object', properties: {} }, _meta: { ui: { visibility: ['app'] } } },
    ],
  }))
  server.setRequestHandler('tools/call', (request) => {
    ran.push(request.params.name)
    return { content: [{ type: 'text', text: `ran ${request.params.name}` }] }
  })
  return server
})

const credentials = new MemoryCredentials()
await credentials.saveTokens('notes', { access_token: 'fixture-token', token_type: 'bearer' }, 0)
const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => notes.fetch(new Request(input, init))
/** The MCP host over the notes server; each program run opens its connection and closes it when it ends. */
const host = mcpHost({
  servers: [{ serverId: 'notes', endpoint: 'https://notes.test/mcp' }],
  credentials,
  grants: new MemoryGrants([{ serverId: 'notes', capability: 'tool', name: 'read' }]),
  registries: new MemoryRegistries(),
  appUrl: 'https://goblin.test',
  fetch: fetcher,
})
/** Resident authority that is always current. */
const resident = stub(Resident, { require: () => Effect.void })
// SAFETY: the capability services read nothing of the instance input that these tools reach.
const instance = { mcpFetch: fetcher } as AgentInputs
const off = (kind: Exclusion['kind'], serverId = '', name = ''): Exclusion => ({ kind, serverId, name })
/**
 * What each conversation works with (ADR 0040): 7 everything, 8 a Topic whose setup holds no server, 9 one that holds
 * only notes' `write`, and 10 a subagent whose spawner switched notes off for it.
 */
const work = (setup: Partial<TopicSetup>) => topicScope({ id: 2, name: 'Work', setup: { ...EVERYTHING, ...setup } })
const scopes: Readonly<Record<string, CapabilityScope>> = {
  '7': scopeOf([], true),
  '8': work({ mcpServers: [] }),
  '9': work({ mcpServers: [{ serverId: 'notes', tools: ['write'] }] }),
  '10': scopeOf([off('server', 'notes')], false),
}
/** The tools' services over the host and the fixed switches above, always resident, on an active plan. */
const profiles = new FixedProfiles(scopes)
const layer = host.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      SingleFlight.layer,
      stub(Capabilities, { scope: (session) => Effect.sync(() => profiles.scope(session)) }),
      // No conversation here is a routine run's.
      stub(RoutineRuns, { session: () => Effect.succeed(undefined) }),
      Layer.succeed(AgentInput, instance),
      sqliteDb(chatDatabase().db),
    ),
  ),
  Layer.merge(Layer.mergeAll(resident, plans())),
)
const run = <A>(program: Effect.Effect<A, AppError, AgentServices>): Promise<A> =>
  // SAFETY: mcp_call and mcp_list need only the MCP, resident authority and capability services provided here.
  Effect.runPromise(Effect.provide(program, layer) as Effect.Effect<A, AppError>)
const tools = residentMcpExtension(run).tools ?? []
const execute = (tool: string, input: Record<string, unknown>, conversationId: number) => {
  const found = tools.find((candidate) => candidate.name === tool)
  if (found === undefined) throw new Error(`${tool} is not registered`)
  return executeTool(found, input, inConversation(conversationId))
}
const call = (name: string, conversationId = 7) =>
  execute('mcp_call', { serverId: 'notes', name, arguments: {} }, conversationId)
const listed = async (input: Record<string, unknown>, conversationId: number): Promise<unknown> => {
  const result = await execute('mcp_list', input, conversationId)
  const [block] = result.content ?? []
  return block?.type === 'text' ? JSON.parse(block.text) : undefined
}

describe('mcp_call and the owner grant (unit)', () => {
  it('runs a granted tool and returns its untrusted result', async () => {
    const result = await call('read')
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain('ran read')
    expect(result.details).toMatchObject({ origin: { serverId: 'notes', trust: 'untrusted' } })
    // Arguments the model sent as the JSON string of an object run the same tool.
    const stringly = await execute('mcp_call', { serverId: 'notes', name: 'read', arguments: '{}' }, 7)
    expect(JSON.stringify(stringly.content)).toContain('ran read')
  })
  it('turns an ungranted tool into a request for the owner instead of an empty error', async () => {
    const result = await call('write')
    expect(result).toMatchObject({
      isError: true,
      details: { kind: 'grant-required', serverId: 'notes', name: 'write' },
    })
    expect(JSON.stringify(result.content)).toContain('Allow button')
  })
  it('never asks the owner about a tool that is missing or meant for an App only', async () => {
    // A failure is an error result the model reads, with no details for the web to turn into an Allow card.
    for (const name of ['missing', 'panel']) {
      const result = await call(name)
      expect(result).toMatchObject({ isError: true })
      expect(result.details).toBeUndefined()
      expect(JSON.stringify(result.content)).toContain('NotFound')
    }
  })
})

describe("what a Topic's setup leaves out (unit)", () => {
  it('leaves a server or tool switched off out of mcp_list', async () => {
    expect(await listed({}, 8)).toEqual({ servers: [] })
    const hidden = await execute('mcp_list', { serverId: 'notes' }, 8)
    expect(hidden.isError).toBe(true)
    expect(JSON.stringify(hidden.content)).toContain('NotFound')
    const notesTools = await listed({ serverId: 'notes' }, 9)
    expect(notesTools).toMatchObject({ tools: [{ name: 'write', granted: false }] })
  })
  it("runs nothing for a server or tool outside the Topic's setup, and offers the owner to add it", async () => {
    ran.length = 0
    expect(await call('read', 8)).toMatchObject({
      isError: true,
      details: { kind: 'not-in-topic', target: { kind: 'server', serverId: 'notes' }, topic: { id: 2, name: 'Work' } },
    })
    const tool = await call('read', 9)
    expect(tool.details).toEqual({
      kind: 'not-in-topic',
      target: { kind: 'tool', serverId: 'notes', name: 'read' },
      topic: { id: 2, name: 'Work' },
    })
    expect(JSON.stringify(tool.content)).toContain('add it to #Work')
    expect(ran).toEqual([])
  })
  it('tells a subagent it cannot, with no card for the owner to answer', async () => {
    const result = await call('read', 10)
    expect(result.isError).toBe(true)
    expect(result.details).toBeUndefined()
    expect(JSON.stringify(result.content)).toContain('the conversation that started you')
  })
})
