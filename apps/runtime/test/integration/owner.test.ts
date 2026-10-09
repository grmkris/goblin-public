import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import { Config, Effect, Schema } from 'effect'
import { ConversationView } from '@goblin/contracts'
import { expect } from 'vitest'
import Stack from './owner-stack.ts'
import { approvalsCase } from './approvals-case.ts'
import { appsCase } from './apps-case.ts'
import { agentAppViewCase } from './agent-app-view-case.ts'
import { queueCase } from './queue-case.ts'
import { topicsCase } from './topics-case.ts'
import { threadHeadsCase } from './thread-heads-case.ts'
import { organizeCase, personasCase } from './persona-case.ts'
import { person, call, ownerFetch } from './owner-requests.ts'

const harness = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
  stage: `test_owner_${process.pid}`,
  dev: true,
})
const stack = harness.beforeAll(harness.deploy(Stack))
harness.test(
  'native: queued follow-ups remain visible, safe removal preserves active work, placement wins, and owners stay isolated',
  stack.pipe(Effect.flatMap(({ url }) => Effect.promise(() => queueCase(url)))),
)
harness.test(
  'native: ask-first approves frozen arguments once, refuses, fences revocation, and never replays recovery',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(() => approvalsCase(url))
  }),
)
harness.test(
  'native: an owner App is kept per call, launches from it, closes with its conversation and is granted live',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(() => appsCase(url))
  }),
)
harness.test(
  'native: an agent app with a view shows in the workspace, launches, and its view calls, reads and reports',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(() => agentAppViewCase(url))
  }),
)
harness.test(
  'native: tagged Personas answer attributed in the chat without Goblin, in order, at their revision, and Stop drops them',
  stack.pipe(Effect.flatMap(({ url }) => Effect.promise(() => personasCase(url)))),
  { timeout: 240_000 },
)
harness.test(
  'native: organize tools leave receipts and Undo applies only while nothing touched the target',
  stack.pipe(Effect.flatMap(({ url }) => Effect.promise(() => organizeCase(url)))),
  { timeout: 240_000 },
)
harness.test(
  'native: Topics create once, talk in their own Conversation, inherit threads, archive, restore and keep inbound in Personal',
  stack.pipe(Effect.flatMap(({ url }) => Effect.promise(() => topicsCase(url)))),
)
harness.test(
  'native: start thread posts a head in its chat, answers in the Thread, and one operation makes one Thread',
  stack.pipe(Effect.flatMap(({ url }) => Effect.promise(() => threadHeadsCase(url)))),
)
harness.test(
  'native: only the session user reaches their own Agent; request selectors cannot redirect it',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(() => ownerRoutingCase(url))
  }),
)

async function ownerRoutingCase(url: string): Promise<void> {
  const owner = await person(url)
  const other = await person(url)
  for (const who of [owner, other])
    await call(url, who, '/__test/billing/override', { userId: who.userId, dailyCredits: 1000 })
  const thread = Schema.decodeUnknownSync(ConversationView)(
    await (await call(url, owner, '/api/conversations', {})).json(),
  )
  const sentinel = `private-owner-${crypto.randomUUID()}`
  const renamed = await ownerFetch(`${url}/api/conversations/${thread.id}`, {
    method: 'PATCH',
    headers: { cookie: owner.cookie, origin: 'https://goblin.test', 'content-type': 'application/json' },
    body: JSON.stringify({ title: sentinel }),
  })
  expect(renamed.status).toBe(200)
  const selection = { 'x-goblin-workspace': owner.userId }
  const foreign = await call(
    url,
    other,
    `/api/conversations?agent=${owner.userId}&workspaceId=${owner.userId}`,
    undefined,
    selection,
  )
  expect(foreign.status).toBe(200)
  expect(await foreign.text()).not.toContain(sentinel)
  expect(await (await call(url, owner, '/api/conversations', undefined, selection)).text()).toContain(sentinel)
  const created = await call(
    url,
    other,
    '/api/conversations',
    { agent: owner.userId, workspaceId: owner.userId },
    selection,
  )
  expect(created.status).toBe(201)
  expect(await (await call(url, other, '/api/conversations')).text()).not.toContain(sentinel)
  for (const path of ['/api/workspaces', '/api/members', '/api/invitations/admission', '/api/interactions'])
    expect((await call(url, owner, path)).status).toBe(404)
  expect(
    (await call(url, owner, `/api/invitations/${crypto.randomUUID()}/preview`, { proof: 'old-proof' })).status,
  ).toBe(404)
}

const primaryProfile = await Effect.runPromise(Config.String('GOBLIN_PRIMARY_PROFILE').pipe(Config.withDefault('root')))
if (primaryProfile === 'permuted')
  harness.test(
    'native: authenticated owner operations leave the Pi root empty',
    Effect.gen(function* () {
      const { url } = yield* stack
      const response = yield* Effect.promise(async () => {
        const owner = await person(url)
        await call(url, owner, '/__test/billing/override', { userId: owner.userId, dailyCredits: 1000 })
        return call(url, owner, '/__test/primary-profile')
      })
      expect(response.status).toBe(200)
      const result = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          session: Schema.String,
          status: Schema.String,
          messages: Schema.Number,
          rootMessages: Schema.Number,
        }),
      )(yield* Effect.promise(() => response.json()))
      expect(result.session).not.toBe('1')
      expect(result.status).toBe('done')
      expect(result.messages).toBeGreaterThan(0)
      expect(result.rootMessages).toBe(0)
    }),
  )
