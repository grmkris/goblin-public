import { createMcpHandler, Server } from '@modelcontextprotocol/server'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppError } from '../src/http/errors.ts'
import { McpHost } from '../src/mcp/host.ts'
import { type CapabilityScope, type Exclusion, scopeOf } from '../src/capabilities/profiles.ts'
import { residentMcpExtension } from '../src/pi/resident-mcp.ts'
import { type AgentServices, Capabilities, Mcp, Resident, Members } from '../src/services.ts'
import { ActiveResident, FixedProfiles, OwnerMembers } from './fixed-services.ts'
import { MemoryCredentials, MemoryGrants } from './mcp/memory.ts'

/** The tools the notes server ran, in order. */
const ran: string[] = []

/** A notes server: `read` is granted, `write` exists but is not, `panel` is for its App only. */
const notes = createMcpHandler(() => {
  // oxlint-disable-next-line typescript/no-deprecated -- the low-level SDK Server keeps this fixture's tool list exact.
  const server = new Server({ name: 'notes', version: '1.0.0' }, { capabilities: { tools: {} } })
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
const host = new McpHost({
  servers: [{ serverId: 'notes', endpoint: 'https://notes.test/mcp' }],
  credentials,
  grants: new MemoryGrants([{ serverId: 'notes', capability: 'tool', name: 'read' }]),
  appUrl: 'https://purrable.test',
  fetch: async (input, init) => notes.fetch(new Request(input, init)),
})
const resident = new ActiveResident()
const off = (kind: Exclusion['kind'], serverId = '', name = ''): Exclusion => ({ kind, serverId, name })
/**
 * Each conversation's switches: 7 has everything on, 8 switched the notes server off, 9 only its `read` tool, and 10
 * is a subagent below a conversation with notes off.
 */
const scopes: Readonly<Record<string, CapabilityScope>> = {
  '7': scopeOf([], true),
  '8': scopeOf([off('server', 'notes')], true),
  '9': scopeOf([off('tool', 'notes', 'read')], true),
  '10': scopeOf([off('server', 'notes')], false),
}
const layer = Layer.mergeAll(
  Layer.succeed(Mcp, host),
  Layer.succeed(Members, new OwnerMembers()),
  Layer.succeed(Resident, resident),
  Layer.succeed(Capabilities, new FixedProfiles(scopes)),
)
const run = <A>(program: Effect.Effect<A, AppError, AgentServices>): Promise<A> =>
  // SAFETY: mcp_call and mcp_list need only the Mcp, Resident, Members and Capabilities services provided here.
  Effect.runPromise(Effect.provide(program, layer) as Effect.Effect<A, AppError>)
const tools = residentMcpExtension(run).tools ?? []
const execute = (tool: string, input: Record<string, unknown>, conversationId: number) => {
  const found = tools.find((candidate) => candidate.name === tool)
  if (found === undefined) throw new Error(`${tool} is not registered`)
  // SAFETY: `input` matches the named tool's parameters (each call site passes that tool's shape); the MCP tools read
  // only `conversationId` from the execution API, and only the abort signal from the context.
  return found.execute(input as never, { conversationId } as never, {} as never)
}
const call = (name: string, conversationId = 7) =>
  execute('mcp_call', { serverId: 'notes', name, arguments: {} }, conversationId)
const listed = async (input: Record<string, unknown>, conversationId: number): Promise<unknown> => {
  const result = await execute('mcp_list', input, conversationId)
  const [block] = result.content ?? []
  return block?.type === 'text' ? JSON.parse(block.text) : undefined
}

afterEach(async () => {
  await host.manager.closeAll()
})

describe('mcp_call and the owner grant (unit)', () => {
  it('runs a granted tool and returns its untrusted result', async () => {
    const result = await call('read')
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain('ran read')
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
    await expect(call('missing')).rejects.toMatchObject({ _tag: 'NotFound' })
    await expect(call('panel')).rejects.toMatchObject({ _tag: 'NotFound' })
  })
})

describe('what a conversation switched off (unit)', () => {
  it('leaves a server or tool switched off out of mcp_list', async () => {
    expect(await listed({}, 8)).toEqual({ servers: [] })
    await expect(listed({ serverId: 'notes' }, 8)).rejects.toMatchObject({ _tag: 'NotFound' })
    const notesTools = await listed({ serverId: 'notes' }, 9)
    expect(notesTools).toMatchObject({ tools: [{ name: 'write', granted: false }] })
  })
  it('runs nothing for a server or tool switched off, and offers the owner to turn it on here', async () => {
    ran.length = 0
    expect(await call('read', 8)).toMatchObject({
      isError: true,
      details: { kind: 'capability-off', target: { kind: 'server', serverId: 'notes' } },
    })
    const tool = await call('read', 9)
    expect(tool.details).toEqual({ kind: 'capability-off', target: { kind: 'tool', serverId: 'notes', name: 'read' } })
    expect(JSON.stringify(tool.content)).toContain('turn it on here')
    expect(ran).toEqual([])
  })
  it('tells a subagent it cannot, with no card for the owner to answer', async () => {
    const result = await call('read', 10)
    expect(result.isError).toBe(true)
    expect(result.details).toBeUndefined()
    expect(JSON.stringify(result.content)).toContain('the conversation that started you')
  })
})
