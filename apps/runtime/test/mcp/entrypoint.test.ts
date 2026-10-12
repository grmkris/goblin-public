import type { Tool } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it } from 'vitest'
import { globalEntrypoint, toolGlobalEntrypoint } from '../../src/mcp/remote.ts'
import type { McpConnectionSnapshot } from '../../src/mcp/types.ts'
import { lowLevelServer } from './low-level-server.ts'
import { hostOf } from './manager.ts'
import { MemoryCredentials, MemoryGrants } from './memory.ts'

/** A tool whose `_meta` is `meta`. */
const tool = (name: string, meta?: Record<string, unknown>): Tool => ({
  name,
  inputSchema: { type: 'object', properties: {} },
  ...(meta === undefined ? {} : { _meta: meta }),
})
const entrypoints = (...types: unknown[]) => ({
  'openai/ui': { entrypoints: types.map((type) => (typeof type === 'string' ? { type } : type)) },
})

const snapshot = (tools: Tool[]): McpConnectionSnapshot => ({
  config: { connectionId: 'c', endpoint: 'https://c.test/mcp' },
  capabilities: {},
  tools,
  resources: [],
  resourceTemplates: [],
  prompts: [],
})

describe('a tool’s global entrypoint (unit)', () => {
  it('reads one from _meta["openai/ui"].entrypoints, with a quick action or without', () => {
    expect(toolGlobalEntrypoint(tool('home', entrypoints('global')))).toBe(true)
    expect(toolGlobalEntrypoint(tool('home', entrypoints('thread', { type: 'global', quickAction: 'Open' })))).toBe(
      true,
    )
    expect(toolGlobalEntrypoint(tool('home', entrypoints('thread', 'file')))).toBe(false)
  })
  it('reads none from anything that does not fit, or is out of bounds', () => {
    expect(toolGlobalEntrypoint(tool('plain'))).toBe(false)
    expect(toolGlobalEntrypoint(tool('home', { 'openai/ui': 'global' }))).toBe(false)
    expect(toolGlobalEntrypoint(tool('home', { 'openai/ui': { entrypoints: 'global' } }))).toBe(false)
    expect(toolGlobalEntrypoint(tool('home', entrypoints('window')))).toBe(false)
    expect(toolGlobalEntrypoint(tool('home', entrypoints({ type: 'global', quickAction: 'x'.repeat(129) })))).toBe(
      false,
    )
    expect(toolGlobalEntrypoint(tool('home', entrypoints(...Array.from({ length: 9 }, () => 'global'))))).toBe(false)
  })
  it("names the first tool that declares one; a tool hidden from the model is still the owner's", () => {
    expect(
      globalEntrypoint(snapshot([tool('a'), tool('b', entrypoints('global')), tool('c', entrypoints('global'))])),
    ).toBe('b')
    expect(globalEntrypoint(snapshot([tool('a')]))).toBeUndefined()
    expect(globalEntrypoint(snapshot([tool('a', { ...entrypoints('global'), ui: { visibility: ['model'] } })]))).toBe(
      'a',
    )
  })
})

const made: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(made.splice(0).map((dispose) => dispose()))
})

/** A server with `tools`, signed in; the owner's list shows what it declares only once the connection is live. */
const serving = async (connectionId: string, endpoint: string, tools: Tool[]) => {
  const handler = createMcpHandler(() => {
    const server = lowLevelServer({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler('tools/list', () => ({ tools }))
    return server
  })
  const credentials = new MemoryCredentials()
  await credentials.saveTokens(connectionId, { access_token: 'fixture', token_type: 'bearer' }, 0)
  const mcp = hostOf({
    servers: [{ connectionId, endpoint, label: connectionId }],
    credentials,
    grants: new MemoryGrants(),
    fetch: async (input, init) => handler.fetch(new Request(input, init)),
  })
  made.push(mcp.dispose)
  return mcp
}

describe('the entrypoint on the owner’s server view (unit)', () => {
  it('shows the tool a server declares as its global entrypoint once it is live, and none before', async () => {
    const mcp = await serving('docs', 'https://docs.test/mcp', [tool('read'), tool('open_home', entrypoints('global'))])
    const entry = async () => (await mcp.servers.list()).find((each) => each.connectionId === 'docs')?.entrypoint
    expect(await entry()).toBeUndefined()
    await mcp.connections.connect('docs')
    expect(await entry()).toBe('open_home')
  })
  it('shows none for a server that declares none', async () => {
    const mcp = await serving('plain', 'https://plain.test/mcp', [tool('read')])
    await mcp.connections.connect('plain')
    expect((await mcp.servers.list())[0]).not.toHaveProperty('entrypoint')
  })
  it('counts a first-class profile’s App tool, live or not', async () => {
    const mcp = await serving('wallet', 'https://wallet.goblin.surf/mcp', [tool('wallet_open')])
    expect((await mcp.servers.list())[0]).toMatchObject({ entrypoint: 'wallet_open' })
  })
})
