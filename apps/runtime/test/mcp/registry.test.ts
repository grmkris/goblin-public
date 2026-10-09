import type { FetchLike } from '@modelcontextprotocol/client'
import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { catalogEntry, DEFAULT_REGISTRIES, makeCatalog, probeRegistry } from '../../src/mcp/registry.ts'
import { MemoryRegistries } from './memory.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

/** A catalog over the owner's registries in memory, whose requests go to `fetcher`. */
const catalogOver = (fetcher: FetchLike, added = new MemoryRegistries()) => makeCatalog({ added, fetch: fetcher })
const search = (catalog: ReturnType<typeof catalogOver>, query: string) => Effect.runPromise(catalog.search(query))

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

/** A registry that answers the registry API with nothing. */
const good: FetchLike = async () => Response.json({ servers: [], metadata: {} })
/** Why a probe of `raw` failed. */
const probe = (raw: string, fetcher: FetchLike) => Effect.runPromise(Effect.flip(probeRegistry(raw, fetcher)))

describe('searching registries', () => {
  it('asks each registry once, de-duplicates by name with the first registry winning, and caches the answer', async () => {
    const asked: string[] = []
    const fetcher: FetchLike = async (input) => {
      const url = new URL(input)
      asked.push(`${url.host}?${url.searchParams.get('search')}`)
      const servers = url.host === 'registry.modelcontextprotocol.io' ? [myplan, walk] : [walk, { junk: true }]
      return Response.json({ servers, metadata: { count: servers.length } })
    }
    const catalog = catalogOver(fetcher)
    const found = await search(catalog, 'plan')
    expect(found.partial).toBe(false)
    expect(found.entries.map((item) => [item.name, item.registryTitle])).toEqual([
      ['lol.myplan/myplan', 'MCP Registry'],
      ['com.walkmyplan/walkmyplan', 'MCP Registry'],
    ])
    await search(catalog, 'plan')
    expect(asked).toEqual(['registry.modelcontextprotocol.io?plan', 'api.mcp.github.com?plan'])
  })

  it('reports a registry that is down or answers garbage, and flags the answer partial without caching it', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((line: string) => void lines.push(line))
    let calls = 0
    const fetcher: FetchLike = async (input) => {
      calls++
      if (new URL(input).host === 'api.mcp.github.com') throw new TypeError('network down')
      return new Response('<html>', { status: 200 })
    }
    const catalog = catalogOver(fetcher)
    expect(await search(catalog, 'x')).toEqual({ entries: [], partial: true })
    const reported = lines.map((line): unknown => JSON.parse(line))
    expect(reported).toHaveLength(2)
    expect(reported).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ where: 'mcp.catalog.search', 'error.type': 'InvalidInput', code: 'not_a_registry' }),
        expect.objectContaining({ where: 'mcp.catalog.search', 'error.type': 'UpstreamMcp', code: 'transport' }),
      ]),
    )
    await search(catalog, 'x')
    expect(calls).toBe(4)
  })

  it('accepts a custom registry only if it speaks the registry API, and tells a dead one from a non-registry', async () => {
    expect(await Effect.runPromise(probeRegistry('https://registry.example.com/anything', good))).toEqual({
      url: 'https://registry.example.com',
      title: 'registry.example.com',
    })
    expect(await probe('https://example.com', async () => Response.json({ hello: 'world' }))).toMatchObject({
      _tag: 'InvalidInput',
      reason: 'not_a_registry',
    })
    expect(await probe('https://example.com', async () => new Response('', { status: 503 }))).toMatchObject({
      reason: 'not_a_registry',
    })
    expect(
      await probe('https://example.com', async () => {
        throw new TypeError('network down')
      }),
    ).toMatchObject({ _tag: 'UpstreamMcp', reason: 'transport', serverId: 'example.com' })
    expect(await probe('http://example.com', good)).toMatchObject({ reason: 'endpoint_not_https' })
  })
})

describe('registries the owner adds', () => {
  it('adds a registry that answers the registry API, searches it after the built-in ones, and removes it', async () => {
    const asked: string[] = []
    const catalog = catalogOver(async (input) => {
      const url = new URL(input)
      asked.push(url.host)
      return Response.json({ servers: url.host === 'registry.example.com' ? [myplan] : [], metadata: {} })
    })
    const after = await Effect.runPromise(catalog.add('https://registry.example.com/v0.1'))
    expect(after.map((item) => [item.url, item.builtIn])).toEqual([
      ['https://registry.modelcontextprotocol.io', true],
      ['https://api.mcp.github.com', true],
      ['https://registry.example.com', false],
    ])
    asked.length = 0
    const found = await search(catalog, 'plan')
    expect(asked).toEqual(['registry.modelcontextprotocol.io', 'api.mcp.github.com', 'registry.example.com'])
    expect(found.entries.map((item) => [item.name, item.registryTitle, item.verified])).toEqual([
      ['lol.myplan/myplan', 'registry.example.com', false],
    ])
    expect(await Effect.runPromise(Effect.flip(catalog.add('https://registry.example.com')))).toMatchObject({
      reason: 'already_added',
    })
    expect(await Effect.runPromise(catalog.remove('https://registry.example.com'))).toHaveLength(2)
    expect(
      await Effect.runPromise(Effect.flip(catalog.remove('https://registry.modelcontextprotocol.io'))),
    ).toMatchObject({ reason: 'unknown_registry' })
  })
})
