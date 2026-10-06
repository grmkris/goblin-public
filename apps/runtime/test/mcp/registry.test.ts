import { describe, expect, it } from 'vitest'
import { McpHost } from '../../src/mcp/host.ts'
import { catalogEntry, DEFAULT_REGISTRIES, RegistryCatalog } from '../../src/mcp/registry.ts'
import { MemoryCredentials, MemoryGrants, MemoryRegistries } from './memory.ts'

const official = DEFAULT_REGISTRIES[0] ?? { url: '', title: '' }
const github = DEFAULT_REGISTRIES[1] ?? { url: '', title: '' }

/** Entries shaped as the live registries returned them on 2026-10-04 (trimmed). */
const entry = (
  server: Record<string, unknown>,
  meta: Record<string, unknown> = { status: 'active', isLatest: true },
) => ({
  server: { $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json', ...server },
  _meta: { 'io.modelcontextprotocol.registry/official': meta },
})
const myplan = entry({
  name: 'lol.myplan/myplan',
  title: 'MyPlan',
  description: 'Notes and canvases.',
  version: '1.2.0',
  remotes: [{ type: 'streamable-http', url: 'https://myplan.lol/mcp' }],
})
const walkRemotes = [{ type: 'streamable-http', url: 'https://mcp.walkmyplan.com/mcp' }]
const walk = entry({ name: 'com.walkmyplan/walkmyplan', version: '3.0.0', remotes: walkRemotes })

describe('registry entries', () => {
  it('keeps the latest active entry with an https streamable-http remote, labelled by its registry', () => {
    expect(catalogEntry(myplan, official)).toEqual({
      registry: 'https://registry.modelcontextprotocol.io',
      registryTitle: 'MCP Registry',
      verified: true,
      name: 'lol.myplan/myplan',
      title: 'MyPlan',
      description: 'Notes and canvases.',
      version: '1.2.0',
      endpoint: 'https://myplan.lol/mcp',
      variables: [],
      needsKey: false,
    })
  })
  it('drops old versions, deprecated entries, package-only servers and plain-http remotes', () => {
    expect(catalogEntry(entry({ name: 'a', remotes: walkRemotes }, { isLatest: false }), official)).toBeUndefined()
    expect(catalogEntry(entry({ name: 'a', remotes: walkRemotes }, { status: 'deprecated' }), official)).toBeUndefined()
    expect(catalogEntry(entry({ name: 'a', packages: [{ registryType: 'npm' }] }), official)).toBeUndefined()
    expect(
      catalogEntry(entry({ name: 'a', remotes: [{ type: 'streamable-http', url: 'http://a.test/mcp' }] }), official),
    ).toBeUndefined()
    expect(catalogEntry({ server: { title: 'no name' } }, official)).toBeUndefined()
  })
  it('names URL template variables and API-key headers, and trusts only the official registry’s namespaces', () => {
    const templated = entry({
      name: 'lol.myplan/workspace',
      remotes: [
        {
          type: 'streamable-http',
          url: 'https://myplan.lol/mcp/{workspaceId}',
          headers: [{ name: 'X-Api-Key', isRequired: true, isSecret: true }],
        },
      ],
    })
    expect(catalogEntry(templated, github)).toMatchObject({
      variables: ['workspaceId'],
      needsKey: true,
      verified: false,
    })
  })
})

describe('searching registries', () => {
  it('asks each registry once, de-duplicates by name with the first registry winning, and caches the answer', async () => {
    const asked: string[] = []
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input)
      asked.push(`${url.host}?${url.searchParams.get('search')}`)
      const servers = url.host === 'registry.modelcontextprotocol.io' ? [myplan, walk] : [walk, { junk: true }]
      return Response.json({ servers, metadata: { count: servers.length } })
    }
    const catalog = new RegistryCatalog(fetcher)
    const found = await catalog.search('plan', DEFAULT_REGISTRIES)
    expect(found.map((item) => [item.name, item.registryTitle])).toEqual([
      ['lol.myplan/myplan', 'MCP Registry'],
      ['com.walkmyplan/walkmyplan', 'MCP Registry'],
    ])
    await catalog.search('plan', DEFAULT_REGISTRIES)
    expect(asked).toEqual(['registry.modelcontextprotocol.io?plan', 'api.mcp.github.com?plan'])
  })
  it('treats a registry that is down or answers garbage as having nothing', async () => {
    const catalog = new RegistryCatalog(async () => new Response('<html>', { status: 200 }))
    expect(await catalog.search('x', DEFAULT_REGISTRIES)).toEqual([])
  })
  it('accepts a custom registry only if it speaks the registry API', async () => {
    const good = new RegistryCatalog(async () => Response.json({ servers: [], metadata: {} }))
    expect(await good.probe('https://registry.example.com/anything')).toEqual({
      url: 'https://registry.example.com',
      title: 'registry.example.com',
    })
    const bad = new RegistryCatalog(async () => Response.json({ hello: 'world' }))
    await expect(bad.probe('https://example.com')).rejects.toMatchObject({ reason: 'not_a_registry' })
    await expect(good.probe('http://example.com')).rejects.toMatchObject({ reason: 'endpoint_not_https' })
  })
})

/** A host with no servers whose registry fetches go to `fetcher`. */
const registryHost = (fetcher: typeof fetch) =>
  new McpHost({
    servers: [],
    credentials: new MemoryCredentials(),
    grants: new MemoryGrants(),
    appUrl: 'https://goblin.test',
    fetch: fetcher,
    registries: new MemoryRegistries(),
  })

describe('registries the owner adds', () => {
  it('adds a registry that answers the registry API, searches it after the built-in ones, and removes it', async () => {
    const asked: string[] = []
    const mcp = registryHost(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input)
      asked.push(url.host)
      return Response.json({ servers: url.host === 'registry.example.com' ? [myplan] : [], metadata: {} })
    })
    const after = await mcp.addRegistry('https://registry.example.com/v0.1')
    expect(after.map((item) => [item.url, item.builtIn])).toEqual([
      ['https://registry.modelcontextprotocol.io', true],
      ['https://api.mcp.github.com', true],
      ['https://registry.example.com', false],
    ])
    asked.length = 0
    const found = await mcp.searchCatalog('plan')
    expect(asked).toEqual(['registry.modelcontextprotocol.io', 'api.mcp.github.com', 'registry.example.com'])
    expect(found.map((item) => [item.name, item.registryTitle, item.verified])).toEqual([
      ['lol.myplan/myplan', 'registry.example.com', false],
    ])
    await expect(mcp.addRegistry('https://registry.example.com')).rejects.toMatchObject({ reason: 'already_added' })
    expect(mcp.removeRegistry('https://registry.example.com')).toHaveLength(2)
    expect(() => mcp.removeRegistry('https://registry.modelcontextprotocol.io')).toThrow()
  })
})
