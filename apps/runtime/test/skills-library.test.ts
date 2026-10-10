import { EVERYTHING } from '@goblin/contracts'
import { ProtocolError, createMcpHandler } from '@modelcontextprotocol/server'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { topicScope } from '../src/setup/scope.ts'
import * as TestClock from 'effect/testing/TestClock'
import type { AppError } from '../src/http/errors.ts'
import { mcpHost } from '../src/mcp/host.ts'
import { skillsExtension } from '../src/pi/skills.ts'
import { Setups } from '../src/setup/service.ts'
import { McpConnections, McpServers, Resident } from '../src/mcp/service.ts'
import type { AgentServices } from '../src/layers/index.ts'
import { SingleFlight } from '../src/observability/single-flight.ts'
import { makeSkills } from '../src/skills/library.ts'
import { Skills } from '../src/skills/service.ts'
import { SKILLS_EXTENSION, type SkillEntry } from '../src/skills/protocol.ts'
import { digestOf } from '../src/skills/verify.ts'
import { FixedProfiles } from './fixed-services.ts'
import { knowledgeOver } from './knowledge-layer.ts'
import { MemoryCredentials, MemoryGrants, MemoryRegistries } from './mcp/memory.ts'
import { MemorySkillState } from './skills-memory.ts'
import { lowLevelServer } from './mcp/low-level-server.ts'
import { servicesOf } from './mcp/runtime.ts'
import { executeTool, inConversation } from './pi-tool.ts'

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
  const server = lowLevelServer(
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

const state = new MemorySkillState()
const credentials = new MemoryCredentials()
await credentials.saveTokens('lib', { access_token: 'fixture-token', token_type: 'bearer' }, 0)
/** The skills service over an MCP host for the skills server, on a test clock that starts at 1,000,000 ms. */
const skillsAt = () => {
  const host = mcpHost({
    servers: [{ serverId: 'lib', endpoint: 'https://skills.test/mcp' }],
    credentials,
    grants: new MemoryGrants(),
    registries: new MemoryRegistries(),
    skillsEnabled: (serverId) => state.enabled(serverId),
    appUrl: 'https://goblin.test',
    fetch: async (input, init) => {
      if (served.down) throw new TypeError('network down')
      return skills.fetch(new Request(input, init))
    },
  })
  const services = servicesOf(
    Layer.effect(Skills, makeSkills(state)).pipe(
      Layer.provideMerge(host),
      Layer.provideMerge(Layer.mergeAll(SingleFlight.layer, TestClock.layer())),
    ),
  )
  return { ...services, library: services.run(Effect.andThen(TestClock.setTime(1_000_000), Skills)) }
}
let services: ReturnType<typeof skillsAt>
let library: Skills['Service']
const later = (ms: number) => services.run(TestClock.adjust(ms))

beforeEach(async () => {
  services = skillsAt()
  library = await services.library
  served.current = await version('v1')
  register(served.current)
  served.tamper = false
  served.down = false
  state.setEnabled('lib', true)
})
afterEach(async () => {
  await services.dispose()
})

describe('skills over MCP (unit)', () => {
  const run = <A, E>(program: Effect.Effect<A, E, McpConnections | McpServers>) => services.run(program)

  it('reads nothing from a server the owner has not turned skills on for', async () => {
    await run(library.setEnabled('lib', false))
    expect(await run(library.catalog())).toEqual({ skills: [], unavailable: [] })
    await expect(run(library.activate('s1', 'lib:code-review'))).rejects.toMatchObject({ _tag: 'NotFound' })
  })

  it('shows the owner which servers offer skills and which are on', async () => {
    const offered = async () => (await run(McpServers.use((servers) => servers.list())))[0]
    await run(library.catalog())
    expect(await offered()).toMatchObject({ serverId: 'lib', skillsOffered: true, skillsEnabled: true })
    await run(library.setEnabled('lib', false))
    expect(await offered()).toMatchObject({ skillsOffered: true, skillsEnabled: false })
  })

  it('lists skills under host handles and activates one with verified content', async () => {
    const catalog = await run(library.catalog())
    expect(catalog.skills.map((skill) => skill.handle)).toEqual(['lib:code-review'])
    const loaded = await run(library.activate('s1', 'lib:code-review'))
    expect(loaded.body).toContain('# Code review v1')
    expect(loaded.files).toEqual([{ path: 'references/checklist.md', size: bytes(CHECKLIST).byteLength }])
    expect(await run(library.read('s1', 'lib:code-review', 'references/checklist.md'))).toEqual({
      kind: 'text',
      path: 'references/checklist.md',
      text: CHECKLIST,
    })
    // A path outside the retained manifest fails its check, which the agent answers as Internal.
    await expect(run(library.read('s1', 'lib:code-review', '../x/SKILL.md'))).rejects.toMatchObject({
      _tag: 'Internal',
    })
  })

  it('refuses bytes that do not match the manifest', async () => {
    served.tamper = true
    state.files.clear()
    await expect(run(library.activate('s2', 'lib:code-review'))).rejects.toMatchObject({ _tag: 'Internal' })
    expect(state.activations('s2')).toEqual([])
  })

  it('resolves a selected stable URI and verifies its bytes before activating it', async () => {
    let checks = 0
    const authorize = () =>
      Effect.sync(() => {
        checks += 1
      })
    const selected = await run(library.activateSelection('selected', 'lib', served.current.entry.uri, { authorize }))
    expect(selected.skill.entry.uri).toBe(served.current.entry.uri)
    expect(selected.body).toContain('# Code review v1')
    expect(checks).toBeGreaterThanOrEqual(2)
    await expect(
      run(library.activateSelection('selected', 'lib', 'skill://missing/SKILL.md', { authorize })),
    ).rejects.toMatchObject({ _tag: 'NotFound' })
    served.tamper = true
    state.files.clear()
    await expect(
      run(library.activateSelection('corrupt', 'lib', served.current.entry.uri, { authorize })),
    ).rejects.toMatchObject({ _tag: 'Internal' })
    expect(state.activations('corrupt')).toEqual([])
  })

  it('ignores a cached file that no longer matches and fetches it again', async () => {
    await run(library.activate('s3', 'lib:code-review'))
    for (const [digest, cached] of state.files) state.files.set(digest, bytes(`${new TextDecoder().decode(cached)}x`))
    expect((await run(library.activate('s3', 'lib:code-review'))).body).toContain('# Code review v1')
  })

  it('keeps a conversation on the version it activated until it activates again', async () => {
    await run(library.activate('s4', 'lib:code-review'))
    served.current = await version('v2')
    register(served.current)
    await later(120_000)
    expect((await run(library.catalog())).skills[0]?.entry.uri).toBe('skill://v2/code-review/SKILL.md')
    // The conversation still reads from v1's retained manifest.
    expect((await run(library.read('s4', 'lib:code-review', 'references/checklist.md'))).kind).toBe('text')
    expect(state.activations('s4').map((item) => item.entry.uri)).toEqual(['skill://v1/code-review/SKILL.md'])
    expect((await run(library.activate('s5', 'lib:code-review'))).body).toContain('# Code review v2')
  })

  it('reports an unreachable server as unavailable rather than empty, and keeps a cached listing', async () => {
    await run(library.catalog())
    await run(McpConnections.use((connections) => connections.close('lib')))
    served.down = true
    expect((await run(library.catalog())).skills).toHaveLength(1)
    // A service made later has no listing of its own to keep.
    await services.dispose()
    services = skillsAt()
    library = await services.library
    await later(600_000)
    expect(await run(library.catalog())).toEqual({ skills: [], unavailable: ['lib'] })
  })
})

describe("a skills library outside the Topic's setup (unit)", () => {
  it('is left out of the catalog without being fetched', async () => {
    served.down = true
    expect(await services.run(library.catalog({}, () => false))).toEqual({ skills: [], unavailable: [] })
  })

  it("loads nothing when the model still asks for one of its skills, and offers to add it to the Topic's setup", async () => {
    const setup = { ...EVERYTHING, skills: [] }
    const profiles = new FixedProfiles({ '4': topicScope({ id: 2, name: 'Work', setup }) })
    const layer = Layer.mergeAll(
      knowledgeOver({ skills: library }),
      Layer.mock(Resident)({ require: () => Effect.void }),
      Layer.mock(Setups)({ scope: (session: string) => Effect.sync(() => profiles.scope(session)) }),
    )
    const run = <A>(program: Effect.Effect<A, AppError, AgentServices>): Promise<A> =>
      // SAFETY: skill_activate needs only the Skills, Resident and Setups services provided here.
      Effect.runPromise(Effect.provide(program, layer) as Effect.Effect<A, AppError>)
    const activate = skillsExtension(run).tools?.find((tool) => tool.name === 'skill_activate')
    if (activate === undefined) throw new Error('skill_activate is not registered')
    const result = await executeTool(activate, { skill: 'lib:code-review' }, inConversation(4))
    expect(result).toMatchObject({
      isError: true,
      details: { kind: 'not-in-topic', target: { kind: 'library', serverId: 'lib' }, topic: { id: 2, name: 'Work' } },
    })
  })
})
