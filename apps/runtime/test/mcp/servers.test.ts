import { createMcpHandler, Server } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import { McpHost } from '../../src/mcp/host.ts'
import { MemoryAddedServers, MemoryCredentials, MemoryGrants } from './memory.ts'

/** A remote that only serves a server card; nothing here connects. */
const remote: typeof fetch = async (input) =>
  new URL(input instanceof Request ? input.url : input).pathname === '/.well-known/mcp/server-card.json'
    ? Response.json({ title: 'Example notes', description: 'Notes, as the publisher puts it.' })
    : new Response('not found', { status: 404 })

function host(random = () => 'abc123') {
  const credentials = new MemoryCredentials()
  const grants = new MemoryGrants()
  const added = new MemoryAddedServers(credentials, grants)
  const mcp = new McpHost({
    servers: [{ serverId: 'myplan', endpoint: 'https://myplan.test/mcp' }],
    credentials,
    grants,
    appUrl: 'https://goblin.test',
    fetch: remote,
    added,
    random,
  })
  return { mcp, grants, added }
}

const reason = async (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => 'ok',
    (error: unknown) => (error instanceof Error && 'reason' in error ? String(error.reason) : 'thrown'),
  )

describe('servers the owner adds', () => {
  it('adds a public endpoint, labelled from its card as the server’s claim, disconnected until connected', async () => {
    const { mcp } = host()
    const view = await mcp.addServer('https://notes.example.com/mcp', { registry: 'https://r.test', name: 'n' })
    expect(view).toEqual({
      serverId: 'notes-example-com-abc123',
      endpoint: 'https://notes.example.com/mcp',
      status: 'disconnected',
      live: false,
      skillsOffered: false,
      skillsEnabled: false,
      source: 'added',
      title: 'Example notes',
      description: 'Notes, as the publisher puts it.',
    })
    expect(mcp.servers().map((server) => [server.serverId, server.source])).toEqual([
      ['myplan', 'config'],
      ['notes-example-com-abc123', 'added'],
    ])
  })
  it('refuses private endpoints, duplicates and more than sixteen servers', async () => {
    let next = 0
    const { mcp } = host(() => String(++next).padStart(6, '0'))
    expect(await reason(mcp.addServer('https://localhost/mcp'))).toBe('endpoint_not_public')
    expect(await reason(mcp.addServer('https://myplan.test/mcp'))).toBe('already_added')
    for (let index = 0; index < 16; index += 1) await mcp.addServer(`https://s${index}.example.com/mcp`)
    expect(await reason(mcp.addServer('https://one-more.example.com/mcp'))).toBe('too_many_servers')
  })
  it('removes an added server with its grants, and never a configured one', async () => {
    const { mcp, grants } = host()
    const { serverId } = await mcp.addServer('https://notes.example.com/mcp')
    grants.set({ serverId, capability: 'tool', name: 'read' }, true)
    await mcp.removeServer(serverId)
    expect(mcp.servers().map((server) => server.serverId)).toEqual(['myplan'])
    expect(grants.list(serverId)).toEqual([])
    expect(await reason(mcp.removeServer('myplan'))).toBe('configured_server')
    expect(await reason(mcp.removeServer('nobody'))).toBe('unknown_server')
  })
})

/** A public server with no sign-in: it publishes no OAuth metadata and refuses any Authorization header it gets. */
const open = createMcpHandler(() => {
  // oxlint-disable-next-line typescript/no-deprecated -- the low-level SDK Server keeps this fixture's tool list exact.
  const server = new Server({ name: 'docs', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler('tools/list', () => ({ tools: [{ name: 'search', inputSchema: { type: 'object' } }] }))
  return server
})
const openFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init)
  if (new URL(request.url).pathname.startsWith('/.well-known/')) return new Response('not found', { status: 404 })
  if (request.headers.has('authorization')) return new Response('unexpected credentials', { status: 400 })
  return open.fetch(request)
}

describe('servers that need no sign-in', () => {
  it('connects without OAuth and sends no Authorization header', async () => {
    const credentials = new MemoryCredentials()
    const grants = new MemoryGrants()
    const mcp = new McpHost({
      servers: [],
      credentials,
      grants,
      appUrl: 'https://goblin.test',
      fetch: openFetch,
      added: new MemoryAddedServers(credentials, grants),
      random: () => 'abc123',
    })
    try {
      const { serverId } = await mcp.addServer('https://docs.example.com/mcp')
      expect(await mcp.beginConnect(serverId)).toEqual({})
      expect(mcp.servers()[0]?.status).toBe('connected')
      expect((await mcp.tools(serverId, true)).map((tool) => tool.name)).toEqual(['search'])
    } finally {
      await mcp.manager.closeAll()
    }
  })
})
