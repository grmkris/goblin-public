import { drizzle } from 'drizzle-orm/durable-sqlite'
import { eq } from 'drizzle-orm'
import { createMcpHandler } from '@modelcontextprotocol/server'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { makeManager } from '../../src/mcp/manager.ts'
import { McpConnections, McpGrants } from '../../src/mcp/service.ts'
import type { McpManagerOptions } from '../../src/mcp/types.ts'
import { SingleFlight } from '../../src/observability/single-flight.ts'
import { PiSessions } from '../../src/pi/sessions.ts'
import { AgentInput, type AgentInputs } from '../../src/runtime/input.ts'
import { SKILLS_EXTENSION } from '../../src/skills/protocol.ts'
import { makeSkills } from '../../src/skills/library.ts'
import { Learner, Skills } from '../../src/skills/service.ts'
import { SqliteSkillState } from '../../src/skills/store.ts'
import { digestOf } from '../../src/skills/verify.ts'
import { runApplicationMigrations } from '../../src/storage/migrations.ts'
import { appSkillFiles } from '../../src/storage/schema.ts'
import { appSkillDrafts } from '../../src/storage/schema.ts'
import { makeLearner } from '../../src/skills/learner.ts'
import { SqliteDraftLog } from '../../src/skills/store.ts'
import { CheapModel } from '../../src/memory/model.ts'
import { scriptedStreams } from './model.ts'
import { makePiModels } from '../../src/pi/model.ts'
import { conversationId } from '../../src/pi/context.ts'
import type { PiHarness } from 'agents/harness/pi'
import { lowLevelServer } from '../mcp/low-level-server.ts'
import { servicesOf } from '../mcp/runtime.ts'

/** The draft tools the learner probe's owner granted. */
const draftTool = (serverId: string, name: string) =>
  serverId === 'myskills' && (name === 'skill_draft' || name === 'skill_draft_status')

/** The connections over `options`, made as the host makes them. */
export const connectionsLayer = (options: McpManagerOptions) =>
  Layer.effect(McpConnections, Effect.orDie(makeManager(options))).pipe(Layer.provide(SingleFlight.layer))

/** The skills service over connections made from `options`, as the agent's start makes it. */
export const skillsOver = (options: McpManagerOptions, state: SqliteSkillState) =>
  servicesOf(
    Layer.effect(Skills, makeSkills(state)).pipe(
      Layer.provide(Layer.mergeAll(connectionsLayer(options), SingleFlight.layer)),
    ),
  )

/** The real skills service and SQLite cache in workerd; the network boundary alone is injected. */
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
    const server = lowLevelServer(
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
  const manager: McpManagerOptions = {
    servers: [{ serverId: 'skills', endpoint: 'https://skills.test/mcp' }],
    skillsEnabled: (serverId) => state.enabled(serverId),
    allows: () => false,
    auth: () => ({ token: async () => '', onUnauthorized: async () => undefined }),
    fetch: (input, init) => handler.fetch(new Request(input, init)),
  }
  state.setEnabled('skills', true, 1)
  const { run, dispose } = skillsOver(manager, state)
  const library = await run(Skills)
  const first = await run(library.activate('cache-session', 'skills:cache-test'))
  db.update(appSkillFiles)
    // Same size, different bytes: exercise digest verification rather than only a size mismatch.
    .set({ content: btoa(new TextDecoder().decode(body).replace('Cache test', 'False test')), storedAt: 2 })
    .where(eq(appSkillFiles.digest, digest))
    .run()
  const second = await run(library.activate('cache-session', 'skills:cache-test'))
  const repaired = state.file(digest)
  await run(library.activate('cache-session', 'skills:cache-test'))
  await dispose()
  return {
    firstBody: first.body,
    secondBody: second.body,
    reads,
    repaired: repaired !== undefined && new TextDecoder().decode(repaired) === new TextDecoder().decode(body),
  }
}

/** Reconstruct the library from SQLite, reading its retained version with a network boundary that must stay unused. */
export async function skillsPersistedRead(storage: DurableObjectStorage) {
  runApplicationMigrations(storage)
  const state = new SqliteSkillState(drizzle(storage))
  const activation = state.activations('cache-session')[0]
  if (activation === undefined || activation.entry.resources === 'dynamic')
    throw new Error('fixture activation missing')
  const resource = activation.entry.resources[0]
  if (resource === undefined) throw new Error('fixture manifest missing')
  let networkCalls = 0
  const manager: McpManagerOptions = {
    servers: [{ serverId: 'skills', endpoint: 'https://skills.test/mcp' }],
    skillsEnabled: (serverId) => state.enabled(serverId),
    allows: () => false,
    auth: () => ({ token: async () => '', onUnauthorized: async () => undefined }),
    fetch: async () => {
      networkCalls += 1
      throw new Error('restart read must use verified persisted bytes')
    },
  }
  const { run, dispose } = skillsOver(manager, state)
  const file = await run(
    Effect.flatMap(Skills, (library) => library.read('cache-session', 'skills:cache-test', 'SKILL.md')),
  )
  const cached = state.file(resource.digest)
  await dispose()
  return {
    activation,
    digest: resource.digest,
    cachedText: cached === undefined ? undefined : new TextDecoder().decode(cached),
    file,
    networkCalls,
  }
}

/** Real workerd SQLite learner state and MCP transport, with a deterministic scripted cheap model and library double. */
export async function skillsLearnerRejectionProbe(storage: DurableObjectStorage, harness: PiHarness) {
  runApplicationMigrations(storage)
  const db = drizzle(storage)
  const state = new SqliteSkillState(db)
  const body = new TextEncoder().encode(
    '---\nname: rejection-proof\ndescription: Keep a checksum procedure.\n---\n\n# Checksum procedure\n',
  )
  const uri = 'skill://skv_222222222222222222222222/rejection-proof/SKILL.md'
  const entry = {
    uri,
    frontmatter: { name: 'rejection-proof', description: 'Keep a checksum procedure.' },
    resources: [{ uri, digest: await digestOf(body), size: body.byteLength }],
  } as const
  let submitted = 0
  let statusCalls = 0
  const handler = createMcpHandler(() => {
    const server = lowLevelServer(
      { name: 'myskills-double', version: '1' },
      { capabilities: { resources: {}, tools: {}, extensions: { [SKILLS_EXTENSION]: {} } } },
    )
    server.setRequestHandler(
      'skills/list',
      { params: Schema.toStandardSchemaV1(Schema.Record(Schema.String, Schema.Unknown)) },
      () => ({ skills: [entry], ttlMs: 60_000 }),
    )
    server.setRequestHandler('resources/list', () => ({ resources: [] }))
    server.setRequestHandler('resources/templates/list', () => ({ resourceTemplates: [] }))
    server.setRequestHandler('resources/read', () => ({
      contents: [{ uri, text: new TextDecoder().decode(body), mimeType: 'text/markdown' }],
    }))
    server.setRequestHandler('tools/list', () => ({
      tools: [
        { name: 'skill_draft', inputSchema: { type: 'object', properties: {} } },
        { name: 'skill_draft_status', inputSchema: { type: 'object', properties: {} } },
      ],
    }))
    server.setRequestHandler('tools/call', (request) => {
      if (request.params.name === 'skill_draft') {
        submitted += 1
        return { content: [], structuredContent: { draftId: 'draft-rejected', status: 'open' } }
      }
      statusCalls += 1
      return { content: [], structuredContent: { draftId: 'draft-rejected', status: 'rejected' } }
    })
    return server
  })
  const manager: McpManagerOptions = {
    servers: [{ serverId: 'myskills', endpoint: 'https://myskills.test/mcp' }],
    skillsEnabled: (serverId) => state.enabled(serverId),
    allows: ({ serverId, capability, name }) => capability === 'tool' && draftTool(serverId, name),
    auth: () => ({ token: async () => '', onUnauthorized: async () => undefined }),
    fetch: (input, init) => handler.fetch(new Request(input, init)),
  }
  state.setEnabled('myskills', true, 1)
  const receipt = await harness.submit('Run the checksum procedure.', {
    operationId: 'checksum-procedure',
  })
  await harness.wait(receipt.operationId)
  const drafts = new SqliteDraftLog(db)
  const decision = JSON.stringify({
    action: 'improve',
    skill: 'myskills:rejection-proof',
    description: 'Verify checksums before submitting a report.',
    body: '1. Calculate the checksum.\n2. Verify it before submitting.',
    evidence: 'The owner corrected the order of checksum verification.',
  })
  const scripted = makePiModels(
    { MODEL_ID: 'learner-fixture', MODEL_BASE_URL: 'https://no-model-calls.invalid', MODEL_KEY: 'unused' },
    scriptedStreams(
      () => undefined,
      () => [{ type: 'text', text: decision }],
    ),
  )
  // SAFETY: PiSessions reads only the harness from the agent's inputs.
  const input = Object.assign(Object.create(null), { harness }) as AgentInputs
  const { run, dispose } = servicesOf(
    Layer.effectContext(
      Effect.gen(function* () {
        const skills = yield* makeSkills(state)
        const learner = yield* makeLearner({
          drafts,
          state,
          skills,
          model: new CheapModel(scripted.models, scripted.model.id, () => undefined),
        })
        return Context.merge(Skills.context(skills), Learner.context(learner))
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          connectionsLayer(manager),
          Layer.mock(McpGrants)({
            policy: (serverId: string, name: string) =>
              Effect.succeed(
                draftTool(serverId, name) ? Option.some({ askFirst: false, version: 'fixture' }) : Option.none(),
              ),
          }),
          PiSessions.layer.pipe(Layer.provide(Layer.succeed(AgentInput, input))),
          SingleFlight.layer,
        ),
      ),
    ),
  )
  await run(Effect.flatMap(Skills, (library) => library.activate(receipt.session, 'myskills:rejection-proof')))
  const corrected = await harness.submit('No, next time verify the checksum before submitting.', {
    operationId: 'checksum-correction',
  })
  await harness.wait(corrected.operationId)
  const learner = await run(Learner)
  const first = await run(learner.consider(conversationId(receipt.session)))
  const repeated = await harness.submit('No, next time verify the checksum before submitting.', {
    operationId: 'checksum-correction-repeat',
  })
  await harness.wait(repeated.operationId)
  const second = await run(learner.consider(conversationId(receipt.session)))
  const row = db.select({ status: appSkillDrafts.status }).from(appSkillDrafts).all()
  await dispose()
  return { first, second, submitted, statusCalls, row }
}
