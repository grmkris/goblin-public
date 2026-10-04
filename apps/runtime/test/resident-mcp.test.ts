import { createMcpHandler, Server } from '@modelcontextprotocol/server'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppError } from '../src/http/errors.ts'
import { McpHost } from '../src/mcp/host.ts'
import { residentMcpExtension } from '../src/pi/resident-mcp.ts'
import { ResidentAuthority } from '../src/resident.ts'
import { type AgentServices, Mcp, Resident } from '../src/services.ts'
import { MemoryCredentials, MemoryGrants } from './mcp/memory.ts'

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
  server.setRequestHandler('tools/call', (request) => ({
    content: [{ type: 'text', text: `ran ${request.params.name}` }],
  }))
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
/** Resident authority that is always active: mcp_call only asks it to `require` the current time. */
class ActiveResident extends ResidentAuthority {
  constructor() {
    // SAFETY: `require` is overridden below and nothing else is called, so the database is never touched.
    super(undefined as never)
  }
  override require(): void {}
}
const resident = new ActiveResident()
const layer = Layer.mergeAll(Layer.succeed(Mcp, host), Layer.succeed(Resident, resident))
const run = <A>(program: Effect.Effect<A, AppError, AgentServices>): Promise<A> =>
  // SAFETY: mcp_call and mcp_list need only the Mcp and Resident services provided here.
  Effect.runPromise(Effect.provide(program, layer) as Effect.Effect<A, AppError>)
const mcpCall = residentMcpExtension(run).tools?.find((tool) => tool.name === 'mcp_call')
const call = (name: string) => {
  if (mcpCall === undefined) throw new Error('mcp_call is not registered')
  // SAFETY: mcp_call reads neither the execution API nor anything in the context beyond the optional abort signal.
  return mcpCall.execute({ serverId: 'notes', name, arguments: {} }, {} as never, {} as never)
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
