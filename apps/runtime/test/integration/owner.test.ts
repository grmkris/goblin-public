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
import { retrievalCase } from './retrieval-case.ts'
import {
  moveApprovalCase,
  moveHelpersCase,
  moveRefusedCase,
  moveRestartCase,
  moveSettledCase,
  moveStopCase,
  moveTopicCase,
} from './move-case.ts'
import { person, call, ownerFetch, workspaceOf, type Person } from './owner-requests.ts'
import { clientErrorsCase, conversationEventsCase, csrfCase, internalRefusalCase } from './edge-case.ts'

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
  'native: cross-Topic retrieval indexes owned entries, searches active Topics unless named, records sources and injects reranked ones',
  stack.pipe(Effect.flatMap(({ url }) => Effect.promise(() => retrievalCase(url)))),
)
harness.test(
  'native: Move to thread moves the newest settled turn into a Thread and the chat leaves it out from then on',
  stack.pipe(Effect.flatMap(({ url }) => Effect.promise(() => moveSettledCase(url)))),
)
harness.test(
  'native: a running, older or moved turn is refused with its reason; one operation makes one move',
  stack.pipe(Effect.flatMap(({ url }) => Effect.promise(() => moveRefusedCase(url)))),
)
harness.test(
  'native: a restart after the fork or after the head finishes the move once',
  stack.pipe(Effect.flatMap(({ url }) => Effect.promise(() => moveRestartCase(url)))),
)
harness.test(
  'native: Stop and Close around a move reach the right run',
  stack.pipe(Effect.flatMap(({ url }) => Effect.promise(() => moveStopCase(url)))),
)
harness.test(
  "native: after a move the turn's helpers report to the Thread, older ones to the chat, and zoom stops at the move",
  stack.pipe(Effect.flatMap(({ url }) => Effect.promise(() => moveHelpersCase(url)))),
)
harness.test(
  'native: a turn waiting on an approval stays in its chat',
  stack.pipe(Effect.flatMap(({ url }) => Effect.promise(() => moveApprovalCase(url)))),
)
harness.test(
  "native: a Topic's Conversation moves too, and 20 chained moves keep its reads within twice their cost",
  stack.pipe(Effect.flatMap(({ url }) => Effect.promise(() => moveTopicCase(url)))),
)
harness.test(
  'native: /api/client-errors takes a content-free report without a session and refuses one that could carry a message',
  stack.pipe(Effect.flatMap(({ url }) => Effect.promise(() => clientErrorsCase(url)))),
)
harness.test(
  'native: an owner write without the CSRF header, or from another origin, is refused at the edge and never applied',
  stack.pipe(Effect.flatMap(({ url }) => Effect.promise(() => csrfCase(url)))),
)
harness.test(
  'native: /internal is refused from outside, signed in or not, while the hooks still reach the agent',
  stack.pipe(Effect.flatMap(({ url }) => Effect.promise(() => internalRefusalCase(url)))),
)
harness.test(
  "native: a chat's event stream through the Worker stays open and carries later commits",
  stack.pipe(Effect.flatMap(({ url }) => Effect.promise(() => conversationEventsCase(url)))),
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
    // Every owner write carries the CSRF header, as the web sends it.
    headers: {
      cookie: owner.cookie,
      origin: 'https://goblin.test',
      'content-type': 'application/json',
      'x-goblin-csrf': '1',
    },
    body: JSON.stringify({ title: sentinel }),
  })
  expect(renamed.status).toBe(200)
  const selection = { 'x-goblin-workspace': owner.userId }
  // What each account's workspace feed shows, as JSON.
  const shown = async (who: Person, path?: string, headers?: Record<string, string>) =>
    JSON.stringify(await workspaceOf(url, who, path, headers))
  const foreign = `/api/workspace/events?agent=${owner.userId}&workspaceId=${owner.userId}`
  expect(await shown(other, foreign, selection)).not.toContain(sentinel)
  expect(await shown(owner, undefined, selection)).toContain(sentinel)
  const created = await call(
    url,
    other,
    '/api/conversations',
    { agent: owner.userId, workspaceId: owner.userId },
    selection,
  )
  expect(created.status).toBe(201)
  expect(await shown(other)).not.toContain(sentinel)
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
