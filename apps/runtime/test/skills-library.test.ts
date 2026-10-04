import { ProtocolError, createMcpHandler, Server } from '@modelcontextprotocol/server'
import * as Schema from 'effect/Schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { McpHost } from '../src/mcp/host.ts'
import { SkillLibrary } from '../src/skills/library.ts'
import { SKILLS_EXTENSION, type SkillEntry } from '../src/skills/protocol.ts'
import type { Activation, SkillState } from '../src/skills/store.ts'
import { digestOf } from '../src/skills/verify.ts'
import { MemoryCredentials, MemoryGrants } from './mcp/memory.ts'

/** The skills state in memory, with the SQLite store's semantics. */
class MemorySkillState implements SkillState {
  readonly #sources = new Set<string>()
  readonly #activations = new Map<string, Activation[]>()
  readonly files = new Map<string, Uint8Array>()
  enabled = (serverId: string) => this.#sources.has(serverId)
  sources = () => [...this.#sources]
  setEnabled(serverId: string, enabled: boolean) {
    if (enabled) this.#sources.add(serverId)
    else this.#sources.delete(serverId)
  }
  activation = (sessionId: string, serverId: string, uri: string) =>
    this.#activations.get(sessionId)?.find((item) => item.serverId === serverId && item.entry.uri === uri)
  activations = (sessionId: string) => this.#activations.get(sessionId) ?? []
  activate(sessionId: string, activation: Activation) {
    const kept = this.activations(sessionId).filter(
      (item) => !(item.serverId === activation.serverId && item.entry.uri === activation.entry.uri),
    )
    this.#activations.set(sessionId, [...kept, activation])
  }
  file = (digest: string) => this.files.get(digest)
  storeFile(digest: string, bytes: Uint8Array) {
    this.files.set(digest, bytes)
  }
}

const bytes = (text: string) => new TextEncoder().encode(text)
const skillMd = (version: string) =>
  `---\nname: code-review\ndescription: Review code using the team's checklist.\n---\n\n# Code review ${version}\n\nRead references/checklist.md.\n`
const CHECKLIST = '# Review checklist\n'

/** A skill version as a server publishes it: version-addressed URIs, files and their manifest entry. */
const version = async (id: string) => {
  const root = `skill://${id}/code-review`
  const files = new Map([
    [`${root}/SKILL.md`, skillMd(id)],
    [`${root}/references/checklist.md`, CHECKLIST],
  ])
  const entry: SkillEntry = {
    uri: `${root}/SKILL.md`,
    frontmatter: { name: 'code-review', description: "Review code using the team's checklist." },
    resources: await Promise.all(
      [...files].map(async ([uri, text]) => ({
        uri,
        digest: await digestOf(bytes(text)),
        size: bytes(text).byteLength,
      })),
    ),
  }
  return { entry, files }
}

/** What the fixture server serves; tests change it between calls. */
const served = {
  current: await version('v1'),
  versions: new Map<string, string>(),
  tamper: false,
  down: false,
}
const register = (published: Awaited<ReturnType<typeof version>>) => {
  for (const [uri, text] of published.files) served.versions.set(uri, text)
}

const AnyParams = Schema.toStandardSchemaV1(Schema.Record(Schema.String, Schema.Unknown))
const skills = createMcpHandler(() => {
  // oxlint-disable-next-line typescript/no-deprecated -- the low-level SDK Server serves the extension methods exactly.
  const server = new Server(
    { name: 'skills', version: '1.0.0' },
    { capabilities: { resources: {}, extensions: { [SKILLS_EXTENSION]: {} } } },
  )
  server.setRequestHandler('skills/list', { params: AnyParams }, () => ({
    resultType: 'complete',
    skills: [served.current.entry],
    ttlMs: 60_000,
    cacheScope: 'private',
  }))
  server.setRequestHandler('skills/get', { params: AnyParams }, (params) => {
    if (params['uri'] !== served.current.entry.uri) throw new ProtocolError(-32602, 'unknown skill')
    return { resultType: 'complete', skill: served.current.entry, ttlMs: 60_000, cacheScope: 'private' }
  })
  server.setRequestHandler('resources/list', () => ({ resources: [] }))
  server.setRequestHandler('resources/read', (request) => {
    const text = served.versions.get(request.params.uri)
    if (text === undefined) throw new ProtocolError(-32602, 'unknown resource')
    return {
      contents: [{ uri: request.params.uri, mimeType: 'text/markdown', text: served.tamper ? `${text}!` : text }],
    }
  })
  return server
})

let clock = 1_000_000
const state = new MemorySkillState()
const credentials = new MemoryCredentials()
await credentials.saveTokens('lib', { access_token: 'fixture-token', token_type: 'bearer' }, 0)
const host = new McpHost({
  servers: [{ serverId: 'lib', endpoint: 'https://skills.test/mcp' }],
  credentials,
  grants: new MemoryGrants(),
  skillsEnabled: (serverId) => state.enabled(serverId),
  appUrl: 'https://purrable.test',
  fetch: async (input, init) => {
    if (served.down) throw new TypeError('network down')
    return skills.fetch(new Request(input, init))
  },
})
const library = new SkillLibrary(host.manager, state, () => clock)

beforeEach(async () => {
  served.current = await version('v1')
  register(served.current)
  served.tamper = false
  served.down = false
  state.setEnabled('lib', true)
})
afterEach(async () => {
  await host.manager.closeAll()
})

describe('skills over MCP (unit)', () => {
  it('reads nothing from a server the owner has not turned skills on for', async () => {
    library.setEnabled('lib', false)
    expect(await library.catalog()).toEqual({ skills: [], unavailable: [] })
    await expect(library.activate('s1', 'lib:code-review')).rejects.toMatchObject({ _tag: 'NotFound' })
  })

  it('shows the owner which servers offer skills and which are on', async () => {
    await library.catalog()
    expect(host.servers()[0]).toMatchObject({ serverId: 'lib', skillsOffered: true, skillsEnabled: true })
    library.setEnabled('lib', false)
    expect(host.servers()[0]).toMatchObject({ skillsOffered: true, skillsEnabled: false })
  })

  it('lists skills under host handles and activates one with verified content', async () => {
    const catalog = await library.catalog()
    expect(catalog.skills.map((skill) => skill.handle)).toEqual(['lib:code-review'])
    const loaded = await library.activate('s1', 'lib:code-review')
    expect(loaded.body).toContain('# Code review v1')
    expect(loaded.files).toEqual([{ path: 'references/checklist.md', size: bytes(CHECKLIST).byteLength }])
    expect(await library.read('s1', 'lib:code-review', 'references/checklist.md')).toEqual({
      kind: 'text',
      path: 'references/checklist.md',
      text: CHECKLIST,
    })
    await expect(library.read('s1', 'lib:code-review', '../x/SKILL.md')).rejects.toMatchObject({
      failure: 'not-in-manifest',
    })
  })

  it('refuses bytes that do not match the manifest', async () => {
    served.tamper = true
    state.files.clear()
    await expect(library.activate('s2', 'lib:code-review')).rejects.toMatchObject({ failure: 'size-mismatch' })
  })

  it('ignores a cached file that no longer matches and fetches it again', async () => {
    await library.activate('s3', 'lib:code-review')
    for (const [digest, cached] of state.files) state.files.set(digest, bytes(`${new TextDecoder().decode(cached)}x`))
    expect((await library.activate('s3', 'lib:code-review')).body).toContain('# Code review v1')
  })

  it('keeps a conversation on the version it activated until it activates again', async () => {
    await library.activate('s4', 'lib:code-review')
    served.current = await version('v2')
    register(served.current)
    clock += 120_000
    expect((await library.catalog()).skills[0]?.entry.uri).toBe('skill://v2/code-review/SKILL.md')
    // The conversation still reads from v1's retained manifest.
    expect((await library.read('s4', 'lib:code-review', 'references/checklist.md')).kind).toBe('text')
    expect(state.activations('s4').map((item) => item.entry.uri)).toEqual(['skill://v1/code-review/SKILL.md'])
    expect((await library.activate('s5', 'lib:code-review')).body).toContain('# Code review v2')
  })

  it('reports an unreachable server as unavailable rather than empty, and keeps a cached listing', async () => {
    await library.catalog()
    await host.manager.closeAll()
    served.down = true
    expect((await library.catalog()).skills).toHaveLength(1)
    clock += 600_000
    const fresh = new SkillLibrary(host.manager, state, () => clock)
    expect(await fresh.catalog()).toEqual({ skills: [], unavailable: ['lib'] })
  })
})
