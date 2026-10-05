import { drizzle } from 'drizzle-orm/durable-sqlite'
import { eq } from 'drizzle-orm'
import { McpConnectionManager } from '../../src/mcp/connection.ts'
import { createMcpHandler, Server } from '@modelcontextprotocol/server'
import * as Schema from 'effect/Schema'
import { SKILLS_EXTENSION } from '../../src/skills/protocol.ts'
import { SkillLibrary } from '../../src/skills/library.ts'
import { SqliteSkillState } from '../../src/skills/store.ts'
import { digestOf } from '../../src/skills/verify.ts'
import { runApplicationMigrations } from '../../src/storage/migrations.ts'
import { appSkillFiles } from '../../src/storage/schema.ts'

/** Real SkillLibrary and SQLite cache in workerd; the network boundary alone is injected. */
export async function skillsCacheProbe(storage: DurableObjectStorage) {
  runApplicationMigrations(storage)
  const db = drizzle(storage)
  const state = new SqliteSkillState(db)
  const body = new TextEncoder().encode(
    '---\nname: cache-test\ndescription: Verify cached skill bytes.\n---\n\n# Cache test\n',
  )
  const uri = 'skill://skv_111111111111111111111111/cache-test/SKILL.md'
  const digest = await digestOf(body)
  const entry = {
    uri,
    frontmatter: { name: 'cache-test', description: 'Verify cached skill bytes.' },
    resources: [{ uri, digest, size: body.byteLength }],
  } as const
  let reads = 0
  const handler = createMcpHandler(() => {
    // oxlint-disable-next-line typescript/no-deprecated -- the low-level SDK Server serves the Skills extension methods.
    const server = new Server(
      { name: 'skills-fixture', version: '1' },
      { capabilities: { resources: {}, extensions: { [SKILLS_EXTENSION]: {} } } },
    )
    server.setRequestHandler(
      'skills/list',
      { params: Schema.toStandardSchemaV1(Schema.Record(Schema.String, Schema.Unknown)) },
      () => ({ skills: [entry], ttlMs: 60_000 }),
    )
    server.setRequestHandler('resources/list', () => ({ resources: [] }))
    server.setRequestHandler('resources/templates/list', () => ({ resourceTemplates: [] }))
    server.setRequestHandler('resources/read', () => {
      reads += 1
      return { contents: [{ uri, text: new TextDecoder().decode(body), mimeType: 'text/markdown' }] }
    })
    return server
  })
  const manager = new McpConnectionManager({
    servers: [{ serverId: 'skills', endpoint: 'https://skills.test/mcp' }],
    skillsEnabled: (serverId) => state.enabled(serverId),
    allows: () => false,
    auth: () => ({ token: async () => '', onUnauthorized: async () => undefined }),
    fetch: (input, init) => handler.fetch(new Request(input, init)),
  })
  state.setEnabled('skills', true, 1)
  const library = new SkillLibrary(manager, state, () => 1)
  const first = await library.activate('cache-session', 'skills:cache-test')
  db.update(appSkillFiles)
    // Same size, different bytes: exercise digest verification rather than only a size mismatch.
    .set({ content: btoa(new TextDecoder().decode(body).replace('Cache test', 'False test')), storedAt: 2 })
    .where(eq(appSkillFiles.digest, digest))
    .run()
  const second = await library.activate('cache-session', 'skills:cache-test')
  const repaired = state.file(digest)
  await library.activate('cache-session', 'skills:cache-test')
  await manager.closeAll()
  return {
    firstBody: first.body,
    secondBody: second.body,
    reads,
    repaired: repaired !== undefined && new TextDecoder().decode(repaired) === new TextDecoder().decode(body),
  }
}
