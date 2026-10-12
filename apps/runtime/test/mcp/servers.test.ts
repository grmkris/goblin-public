import { createMcpHandler } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryAddedServers, MemoryCredentials, MemoryGrants } from './memory.ts'
import { lowLevelServer } from './low-level-server.ts'
import { hostOf } from './manager.ts'

/** The hosts a test made, ended after it. */
const made: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(made.splice(0).map((dispose) => dispose()))
})

/** A remote that only serves a server card; nothing here connects. */
const remote: typeof fetch = async (input) =>
  new URL(input instanceof Request ? input.url : input).pathname === '/.well-known/mcp/server-card.json'
    ? Response.json({ title: 'Example notes', description: 'Notes, as the publisher puts it.' })
    : new Response('not found', { status: 404 })

function host(random = () => 'abc123') {
  const credentials = new MemoryCredentials()
  const grants = new MemoryGrants()
  const added = new MemoryAddedServers(credentials, grants)
  const { servers: mcp, dispose } = hostOf({
    servers: [{ connectionId: 'myplan', endpoint: 'https://myplan.test/mcp' }],
    credentials,
    grants,
    fetch: remote,
    added,
    random,
  })
  made.push(dispose)
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
    const view = await mcp.add('https://notes.example.com/mcp', undefined, { registry: 'https://r.test', name: 'n' })
    expect(view).toEqual({
      connectionId: 'notes-example-com-abc123',
      label: 'Example notes',
      endpoint: 'https://notes.example.com/mcp',
      status: 'disconnected',
      live: false,
      skillsOffered: false,
      skillsEnabled: false,
      source: 'added',
      title: 'Example notes',
      description: 'Notes, as the publisher puts it.',
    })
    expect((await mcp.list()).map((server) => [server.connectionId, server.source])).toEqual([
      ['myplan', 'config'],
      ['notes-example-com-abc123', 'added'],
    ])
  })
  it('refuses private endpoints and more than thirty-two connections', async () => {
    let next = 0
    const { mcp } = host(() => String(++next).padStart(6, '0'))
    expect(await reason(mcp.add('https://localhost/mcp'))).toBe('endpoint_not_public')
    for (let index = 0; index < 32; index += 1) await mcp.add(`https://s${index}.example.com/mcp`)
    expect(await reason(mcp.add('https://one-more.example.com/mcp'))).toBe('too_many_servers')
  })

  it('connects one server twice, as two connections the owner names, each its own id', async () => {
    let next = 0
    const { mcp } = host(() => String(++next).padStart(6, '0'))
    const hirer = await mcp.add('https://notes.example.com/mcp', 'Notes · Hirer')
    const worker = await mcp.add('https://notes.example.com/mcp', 'Notes · Worker')
    const third = await mcp.add('https://notes.example.com/mcp')
    expect([hirer, worker, third].map(({ connectionId, label }) => [connectionId, label])).toEqual([
      ['notes-example-com-000001', 'Notes · Hirer'],
      ['notes-example-com-000002', 'Notes · Worker'],
      ['notes-example-com-000003', 'Example notes'],
    ])
    expect((await mcp.add('https://notes.example.com/mcp')).label).toBe('Example notes 2')
    expect(await reason(mcp.add('https://notes.example.com/mcp', 'notes · hirer'))).toBe('label_taken')
    expect((await mcp.list()).find((each) => each.connectionId === 'myplan')?.label).toBe('myplan')
  })

  it("names a connection to a server goblin knows by goblin's own name for it, not its card or host", async () => {
    let next = 0
    const { mcp } = host(() => String(++next).padStart(6, '0'))
    const first = await mcp.add('https://wallet-dev.goblin.surf/mcp')
    const second = await mcp.add('https://wallet-dev.goblin.surf/mcp')
    expect([first.label, second.label]).toEqual(['Goblin Wallet', 'Goblin Wallet 2'])
  })

  it("names a connection added from the shelf by the shelf's title, on any stage's endpoint", async () => {
    let next = 0
    const { mcp } = host(() => String(++next).padStart(6, '0'))
    expect((await mcp.add('https://mcp.kiwi.com')).label).toBe('Kiwi.com')
    expect((await mcp.add('https://mysi.lol/mcp')).label).toBe('mysi')
    expect((await mcp.add('https://notes.example.com/mcp')).label).toBe('Example notes')
  })

  it('renames a connection, configured or added, never onto a label another holds', async () => {
    const { mcp } = host()
    const notes = await mcp.add('https://notes.example.com/mcp', 'Notes')
    expect((await mcp.rename('myplan', 'Plans')).label).toBe('Plans')
    expect((await mcp.rename(notes.connectionId, 'Notes · Mine')).label).toBe('Notes · Mine')
    expect(await reason(mcp.rename(notes.connectionId, 'PLANS'))).toBe('label_taken')
    expect(await reason(mcp.rename('nobody', 'Nobody'))).toBe('thrown')
  })
  it('removes an added server with its grants, and never a configured one', async () => {
    const { mcp, grants } = host()
    const { connectionId } = await mcp.add('https://notes.example.com/mcp')
    grants.set({ connectionId, capability: 'tool', name: 'read' }, true)
    await mcp.remove(connectionId)
    expect((await mcp.list()).map((server) => server.connectionId)).toEqual(['myplan'])
    expect(grants.list(connectionId)).toEqual([])
    expect(await reason(mcp.remove('myplan'))).toBe('configured_server')
    expect(await reason(mcp.remove('nobody'))).toBe('unknown_server')
  })
})

/** A public server with no sign-in: it publishes no OAuth metadata and refuses any Authorization header it gets. */
const open = createMcpHandler(() => {
  const server = lowLevelServer({ name: 'docs', version: '1.0.0' }, { capabilities: { tools: {} } })
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
    const { servers: mcp, dispose } = hostOf({
      servers: [],
      credentials,
      grants,
      fetch: openFetch,
      added: new MemoryAddedServers(credentials, grants),
      random: () => 'abc123',
    })
    try {
      const { connectionId } = await mcp.add('https://docs.example.com/mcp')
      expect(await mcp.beginConnect(connectionId)).toEqual({})
      expect((await mcp.list())[0]?.status).toBe('connected')
      expect((await mcp.tools(connectionId, true)).map((tool) => tool.name)).toEqual(['search'])
    } finally {
      await dispose()
    }
  })

  it('is not connected, rather than waiting for sign-in, after its first connect cannot reach it', async () => {
    const credentials = new MemoryCredentials()
    const grants = new MemoryGrants()
    let down = true
    const { servers: mcp, dispose } = hostOf({
      servers: [],
      credentials,
      grants,
      fetch: async (input, init) => {
        const { pathname } = new URL(new Request(input, init).url)
        if (down && pathname === '/mcp') throw new TypeError('fetch failed')
        return openFetch(input, init)
      },
      added: new MemoryAddedServers(credentials, grants),
      random: () => 'abc123',
    })
    try {
      const { connectionId } = await mcp.add('https://docs.example.com/mcp')
      await expect(mcp.beginConnect(connectionId)).rejects.toMatchObject({ _tag: 'UpstreamMcp', reason: 'transport' })
      expect((await mcp.list())[0]?.status).toBe('disconnected')
      down = false
      expect(await mcp.beginConnect(connectionId)).toEqual({})
      expect((await mcp.list())[0]?.status).toBe('connected')
      expect((await mcp.tools(connectionId, false)).map((tool) => tool.name)).toEqual(['search'])
    } finally {
      await dispose()
    }
  })
})
