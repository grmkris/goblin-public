import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import { Effect, Schema } from 'effect'
import { WorkspaceState } from '@purrable/contracts'
import { expect } from 'vitest'
import Stack from './members-stack.ts'

const harness = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
  stage: 'test_members',
  dev: true,
})
const stack = harness.beforeAll(harness.deploy(Stack))
const Signup = Schema.Struct({ user: Schema.Struct({ id: Schema.String }) })
interface Person {
  readonly userId: string
  readonly cookie: string
  readonly ip: string
}
async function person(base: string): Promise<Person> {
  const ip = `2001:db8:${Array.from(crypto.getRandomValues(new Uint16Array(4)), (n) => n.toString(16)).join(':')}:0:1`
  const response = await fetch(`${base}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { origin: 'https://purrable.test', 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({
      email: `${crypto.randomUUID()}@fixture.test`,
      name: 'Members fixture',
      password: 'fixture-password-12345',
    }),
  })
  expect(response.status).toBe(200)
  return {
    userId: Schema.decodeUnknownSync(Signup)(await response.json()).user.id,
    ip,
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; '),
  }
}
const call = (base: string, who: Person, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      cookie: who.cookie,
      origin: 'https://purrable.test',
      'content-type': 'application/json',
      'x-purrable-csrf': '1',
      'cf-connecting-ip': who.ip,
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const state = async (base: string, who: Person) =>
  Schema.decodeUnknownSync(WorkspaceState)(await (await call(base, who, '/api/workspaces')).json())
const lever = (base: string, who: Person, action: string, extra: Record<string, unknown> = {}) =>
  call(base, who, `/__test/members/${action}`, { userId: who.userId, ...extra })
const pay = (base: string, who: Person) => call(base, who, '/__test/billing/override', { userId: who.userId })

async function resolutionCase(base: string) {
  const owner = await person(base)
  const stranger = await person(base)
  const first = await state(base, owner)
  expect(first.active).toMatchObject({ role: 'owner', agentReady: true })
  expect(await state(base, owner)).toEqual(first)
  await pay(base, owner)
  expect((await call(base, owner, '/api/threads')).status).toBe(200)
  const foreign = (await state(base, stranger)).active?.id
  expect(
    (await call(base, owner, '/api/workspaces/active', { workspaceId: foreign, context: first.context })).status,
  ).toBe(404)
  expect(
    (await call(base, owner, '/api/workspaces/active', { workspaceId: first.active?.id, context: null })).status,
  ).toBe(409)
  expect(
    (
      await call(
        base,
        owner,
        '/api/workspaces/active',
        { workspaceId: first.active?.id, context: first.context },
        { 'x-purrable-csrf': '0' },
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await call(
        base,
        owner,
        '/api/workspaces/active',
        { workspaceId: first.active?.id, context: first.context },
        { origin: 'https://foreign.test' },
      )
    ).status,
  ).toBe(403)
  expect(
    (await call(base, owner, '/api/workspaces/active', { workspaceId: first.active?.id, context: first.context }))
      .status,
  ).toBe(200)
  expect(
    (await call(base, owner, '/api/threads', undefined, { 'x-purrable-workspace': first.context ?? '' })).status,
  ).toBe(409)
}
harness.test(
  'native Members: stable owner routing, foreign IDs, exact CSRF and stale selection fence',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(() => resolutionCase(url))
  }),
)

async function membershipCase(base: string) {
  const owner = await person(base)
  const shared = (await state(base, owner)).active?.id
  for (const role of ['member', 'viewer'] as const) {
    const invitee = await person(base)
    await lever(base, invitee, 'invitation-account')
    expect((await state(base, invitee)).workspaces).toEqual([])
    await lever(base, invitee, 'member', { workspaceId: shared, role })
    await pay(base, invitee)
    expect((await call(base, invitee, '/api/workspaces/active', { workspaceId: shared, context: null })).status).toBe(
      200,
    )
    expect((await state(base, invitee)).active).toMatchObject({ role, agentReady: false })
    for (const path of ['/api/threads', '/api/agent/resident', '/api/mcp/servers'])
      expect((await call(base, invitee, path)).status).toBe(403)
    await lever(base, invitee, 'revoke')
    expect((await state(base, invitee)).active).toBeNull()
    expect((await call(base, invitee, '/api/threads')).status).toBe(404)
  }
}
harness.test(
  'native Members: invitation-only accounts have no fallback; shared member/viewer RPCs stay closed',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(() => membershipCase(url))
  }),
)

async function deletionCase(base: string) {
  const owner = await person(base)
  const other = await person(base)
  const shared = (await state(base, owner)).active?.id
  await state(base, other)
  await pay(base, owner)
  await pay(base, other)
  await lever(base, other, 'member', { workspaceId: shared })
  expect((await call(base, owner, '/api/threads')).status).toBe(200)
  expect((await lever(base, owner, 'delete-fault')).status).toBe(500)
  expect((await state(base, owner)).active).toBeNull()
  expect((await call(base, owner, '/api/threads')).status).toBe(404)
  expect((await call(base, other, '/api/threads')).status).toBe(200)
  const deleted = await (await lever(base, owner, 'delete')).json()
  expect(deleted).toMatchObject({ state: 'deleted', deletionPhase: 'destroyed' })
  expect((await state(base, owner)).workspaces).toEqual([])
  const inviter = await person(base)
  const invitee = await person(base)
  const workspaceId = (await state(base, inviter)).active?.id
  await pay(base, inviter)
  await lever(base, invitee, 'invitation-account')
  await lever(base, invitee, 'member', { workspaceId })
  expect(await (await lever(base, invitee, 'delete')).json()).toBeNull()
  expect((await call(base, inviter, '/api/threads')).status).toBe(200)
}
harness.test(
  'native Members: owner destruction faults leave access closed; retry and foreign-member deletion preserve owners',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(() => deletionCase(url))
  }),
)
