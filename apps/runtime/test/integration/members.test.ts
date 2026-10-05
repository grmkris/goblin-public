import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import { Effect, Schema } from 'effect'
import { InvitationView, MembersState, WorkspaceState } from '@purrable/contracts'
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
  readonly email: string
}
async function person(base: string): Promise<Person> {
  const ip = `2001:db8:${Array.from(crypto.getRandomValues(new Uint16Array(4)), (n) => n.toString(16)).join(':')}:0:1`
  const email = `${crypto.randomUUID()}@fixture.test`
  const response = await fetch(`${base}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { origin: 'https://purrable.test', 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({
      email,
      name: 'Members fixture',
      password: 'fixture-password-12345',
    }),
  })
  expect(response.status).toBe(200)
  return {
    userId: Schema.decodeUnknownSync(Signup)(await response.json()).user.id,
    ip,
    email,
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
const MAIL = { 'x-fixture-mail': '1' }
const NONE = { servers: [], skills: [], mainHistory: 'own' }
const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
const mergedCookies = (...cookies: string[]): string =>
  [
    ...new Map(
      cookies.flatMap((cookie) =>
        cookie
          .split(';')
          .filter(Boolean)
          .map((item) => {
            const offset = item.indexOf('=')
            return [item.slice(0, offset).trim(), item.slice(offset + 1)] as const
          }),
      ),
    ).entries(),
  ]
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
const cookiesAfter = (current: string, response: Response): string => {
  const cleared = response.headers
    .getSetCookie()
    .filter((cookie) => /;\s*max-age=0(?:;|$)/iu.test(cookie))
    .map((cookie) => cookie.slice(0, cookie.indexOf('=')))
  return mergedCookies(
    current
      .split(';')
      .filter((cookie) => !cleared.some((name) => cookie.trim().startsWith(`${name}=`)))
      .join('; '),
    ...response.headers
      .getSetCookie()
      .filter((cookie) => !/;\s*max-age=0(?:;|$)/iu.test(cookie))
      .map((cookie) => cookie.split(';')[0] ?? ''),
  )
}
const roster = async (base: string, who: Person) =>
  Schema.decodeUnknownSync(MembersState)(await (await call(base, who, '/api/members')).json())
const mail = async (base: string, who: Person, email: string) =>
  Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String, from: Schema.String, subject: Schema.String }))(
    await (await lever(base, who, 'mail', { email })).json(),
  )
async function invite(base: string, owner: Person, email: string, operationId = crypto.randomUUID()) {
  const response = await call(
    base,
    owner,
    '/api/invitations',
    { email, role: 'member', policy: NONE, operationId },
    MAIL,
  )
  expect(response.status).toBe(200)
  const receipt = Schema.decodeUnknownSync(InvitationView)(await response.json())
  const sent = await mail(base, owner, email)
  expect(sent.from).toBe('hello@purrable.lol')
  expect(sent.subject).toBe('[purrable.test] Invitation to Purrable')
  return {
    receipt,
    fragment: /#([a-f0-9]{64})/u.exec(sent.text)?.[1] ?? '',
    code: /page: ([A-F0-9]{20})/u.exec(sent.text)?.[1] ?? '',
    operationId,
  }
}
async function proof(base: string, who: Person, id: string, presented: string) {
  const response = await call(base, who, `/api/invitations/${id}/preview`, { proof: presented }, MAIL)
  return { response, person: { ...who, cookie: mergedCookies(who.cookie, cookieOf(response)) } }
}
async function codeSignIn(base: string, who: Person) {
  const response = await call(
    base,
    who,
    '/api/auth/email-otp/send-verification-otp',
    { email: who.email, type: 'sign-in' },
    MAIL,
  )
  expect(response.status).toBe(200)
  const otp = /code is (\d{6})/u.exec((await mail(base, who, who.email)).text)?.[1] ?? ''
  const verified = await call(base, who, '/api/auth/sign-in/email-otp', { email: who.email, otp }, MAIL)
  expect(verified.status).toBe(200)
  return {
    ...who,
    userId: Schema.decodeUnknownSync(Signup)(await verified.json()).user.id,
    cookie: mergedCookies(who.cookie, cookieOf(verified)),
  }
}
const accept = (base: string, who: Person, id: string) => call(base, who, `/api/invitations/${id}/accept`, {}, MAIL)

const QueryObservation = Schema.Struct({
  reads: Schema.Number,
  writes: Schema.Number,
  status: Schema.Number,
  result: Schema.optional(Schema.Unknown),
})
async function observe(base: string, who: Person, mode: 'state' | 'browser' | 'owner', context?: string) {
  return Schema.decodeUnknownSync(QueryObservation)(
    await (
      await call(
        base,
        who,
        '/__test/members/queries',
        { mode },
        context === undefined ? {} : { 'x-purrable-workspace': context },
      )
    ).json(),
  )
}
async function oneRead(base: string, who: Person, mode: 'state' | 'browser' | 'owner', status = 200, context?: string) {
  const result = await observe(base, who, mode, context)
  expect(result).toMatchObject({ reads: 1, writes: 0, status })
  return result
}
async function readBudgetCase(base: string) {
  const owner = await person(base)
  const cold = await observe(base, owner, 'state')
  expect(cold.status).toBe(200)
  expect(cold.writes).toBeGreaterThan(0)
  const initial = Schema.decodeUnknownSync(WorkspaceState)(cold.result)
  expect(initial.active).toMatchObject({ role: 'owner', agentReady: true })
  expect((await oneRead(base, owner, 'state')).result).toEqual(initial)
  await oneRead(base, owner, 'browser')
  await oneRead(base, owner, 'owner')
  await oneRead(base, owner, 'browser', 409, 'stale-context')
  const selector = await person(base)
  // Owner/MCP resolution provisions ownership without selecting a browser workspace.
  const provisioned = await observe(base, selector, 'owner')
  expect(provisioned.status).toBe(200)
  const workspace = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(provisioned.result)
  expect(
    (await call(base, selector, '/api/workspaces/active', { workspaceId: workspace.id, context: null })).status,
  ).toBe(200)
  await oneRead(base, selector, 'browser')
  for (const role of ['member', 'viewer'] as const) {
    const invitee = await person(base)
    await lever(base, invitee, 'invitation-account')
    expect(Schema.decodeUnknownSync(WorkspaceState)((await oneRead(base, invitee, 'state')).result).workspaces).toEqual(
      [],
    )
    await oneRead(base, invitee, 'owner', 404)
    await lever(base, invitee, 'member', { workspaceId: initial.active?.id, role })
    expect(
      (await call(base, invitee, '/api/workspaces/active', { workspaceId: initial.active?.id, context: null })).status,
    ).toBe(200)
    await oneRead(base, invitee, 'state')
    await oneRead(base, invitee, 'browser', 403)
    await oneRead(base, invitee, 'owner', 404)
    await lever(base, invitee, 'revoke')
    await oneRead(base, invitee, 'browser', 404)
  }
  await lever(base, owner, 'delete-fault')
  expect(Schema.decodeUnknownSync(WorkspaceState)((await oneRead(base, owner, 'state')).result).active).toBeNull()
  await oneRead(base, owner, 'browser', 404)
  await oneRead(base, owner, 'owner', 404)
}
harness.test(
  'native Members: one live read and no steady-state writes preserve cold provision, invitation and revocation fences',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(() => readBudgetCase(url))
  }),
)
async function cleanupCase(base: string) {
  const owner = await person(base)
  await state(base, owner)
  await pay(base, owner)
  const invitation = await invite(base, owner, `${crypto.randomUUID()}@fixture.test`)
  const result = await (await lever(base, owner, 'maintenance', { invitationId: invitation.receipt.id })).json()
  expect(result).toEqual({
    before: { admissions: 1003, rates: 1003 },
    first: { admissions: 3, rates: 3 },
    second: { admissions: 2, rates: 2 },
    repeated: { admissions: 2, rates: 2 },
    retainedAttempts: 20,
  })
}
harness.test(
  'native Members: scheduled cleanup without Dodo bounds expiry sweeps and retains live proofs and hourly counters',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(() => cleanupCase(url))
  }),
)

async function resolutionCase(base: string) {
  const owner = await person(base)
  const stranger = await person(base)
  const first = await state(base, owner)
  expect(first.active).toMatchObject({ role: 'owner', agentReady: true })
  expect(await state(base, owner)).toEqual(first)
  await pay(base, owner)
  await pay(base, stranger)
  expect((await call(base, owner, '/api/conversations')).status).toBe(200)
  const thread = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
    await (await call(base, owner, '/api/conversations', {})).json(),
  )
  const sentinel = `owner-thread-${crypto.randomUUID()}`
  const renamed = await fetch(`${base}/api/conversations/${thread.id}`, {
    method: 'PATCH',
    headers: { cookie: owner.cookie, origin: 'https://purrable.test', 'content-type': 'application/json' },
    body: JSON.stringify({ title: sentinel }),
  })
  expect(renamed.status).toBe(200)
  expect(await (await call(base, owner, '/api/conversations')).text()).toContain(sentinel)
  expect(
    await (
      await call(base, stranger, `/api/conversations?agent=${owner.userId}&workspaceId=${first.active?.id}`)
    ).text(),
  ).not.toContain(sentinel)
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
    (await call(base, owner, '/api/conversations', undefined, { 'x-purrable-workspace': first.context ?? '' })).status,
  ).toBe(409)
  expect(
    (await call(base, owner, '/api/members', undefined, { 'x-purrable-workspace': first.context ?? '' })).status,
  ).toBe(409)
}
harness.test(
  'native Members: stable owner routing, foreign IDs, exact CSRF and stale selection fence',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(() => resolutionCase(url))
  }),
)

async function existingAccountCase(base: string) {
  const owner = await person(base)
  await state(base, owner)
  await pay(base, owner)
  const existing = await person(base)
  const personal = await state(base, existing)
  await pay(base, existing)
  const invitation = await invite(base, owner, existing.email)
  const exchange = await proof(base, existing, invitation.receipt.id, invitation.fragment)
  const signedIn = await codeSignIn(base, exchange.person)
  const concurrent = await Promise.all([
    accept(base, signedIn, invitation.receipt.id),
    accept(base, signedIn, invitation.receipt.id),
  ])
  expect(concurrent.map((response) => response.status)).toEqual([200, 200])
  expect(await concurrent[0]?.json()).toEqual(await concurrent[1]?.json())
  const joined = await state(base, signedIn)
  expect(joined.workspaces).toHaveLength(2)
  expect(joined.active?.id).toBe(personal.active?.id)
  const shared = joined.workspaces.find((workspace) => workspace.role === 'member')
  expect(
    (await call(base, signedIn, '/api/workspaces/active', { workspaceId: shared?.id, context: joined.context })).status,
  ).toBe(200)
  const selected = await state(base, signedIn)
  const leave = { version: selected.active?.memberVersion, operationId: crypto.randomUUID() }
  expect((await call(base, signedIn, '/api/members/me/leave', { ...leave, policy: NONE })).status).toBe(400)
  expect(
    (
      await call(base, signedIn, '/api/members/me/leave', {
        ...leave,
        policy: { ...NONE, servers: [{ serverId: 'foreign', endpoint: 'https://foreign.test/mcp', tools: ['call'] }] },
      })
    ).status,
  ).toBe(400)
  expect((await call(base, signedIn, '/api/members/me/leave', { ...leave, role: 'member' })).status).toBe(400)
  expect((await state(base, signedIn)).active).toEqual(selected.active)
  expect((await call(base, signedIn, '/api/members/me/leave', leave)).status).toBe(200)
  expect((await call(base, signedIn, '/api/members/me/leave', leave)).status).toBe(200)
  expect((await call(base, signedIn, '/api/members/me/leave', { ...leave, version: 99 })).status).toBe(409)
  const left = await state(base, signedIn)
  expect(left.active).toBeNull()
  expect(left.workspaces.map((workspace) => workspace.id)).toEqual([personal.active?.id])
  expect((await call(base, signedIn, '/api/conversations')).status).toBe(404)
  expect(
    (await call(base, signedIn, '/api/workspaces/active', { workspaceId: personal.active?.id, context: left.context }))
      .status,
  ).toBe(200)
  expect((await call(base, signedIn, '/api/conversations')).status).toBe(200)
  expect(
    (await call(base, owner, '/api/members/me/leave', { version: 1, operationId: crypto.randomUUID() })).status,
  ).toBe(403)
}
harness.test(
  'native Members: concurrent acceptance preserves existing personal workspace; leave closes selection without fallback',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(() => existingAccountCase(url))
  }),
)

async function proofFencesCase(base: string) {
  const owner = await person(base)
  await state(base, owner)
  await pay(base, owner)
  const empty: Person = { userId: '', cookie: '', ip: owner.ip, email: `${crypto.randomUUID()}@fixture.test` }
  const invitation = await invite(base, owner, empty.email)
  expect(
    (
      await call(
        base,
        empty,
        `/api/invitations/${invitation.receipt.id}/preview`,
        { proof: invitation.fragment },
        { ...MAIL, 'x-purrable-csrf': '0' },
      )
    ).status,
  ).toBe(403)
  const admitted = await proof(base, empty, invitation.receipt.id, invitation.fragment)
  expect(admitted.response.status).toBe(200)
  const sent = await call(
    base,
    admitted.person,
    '/api/auth/email-otp/send-verification-otp',
    { email: empty.email, type: 'sign-in' },
    MAIL,
  )
  expect(sent.status).toBe(200)
  const otp = /code is (\d{6})/u.exec((await mail(base, owner, empty.email)).text)?.[1] ?? ''
  await lever(base, owner, 'expire-admission', { email: empty.email })
  expect(
    (await call(base, admitted.person, '/api/auth/sign-in/email-otp', { email: empty.email, otp }, MAIL)).status,
  ).toBe(403)
  const guessed = await invite(base, owner, `${crypto.randomUUID()}@fixture.test`)
  for (let attempt = 0; attempt < 5; attempt++)
    expect((await proof(base, empty, guessed.receipt.id, '0'.repeat(64))).response.status).toBe(403)
  expect((await proof(base, empty, guessed.receipt.id, '0'.repeat(64))).response.status).toBe(429)
  const pending = await invite(base, owner, `${crypto.randomUUID()}@fixture.test`)
  await lever(base, owner, 'delete-fault')
  expect((await proof(base, empty, pending.receipt.id, pending.fragment)).response.status).toBe(404)
}
harness.test(
  'native Members: proof CSRF/guess limits, expiry between OTP send/verify and deleting-owner invitation barrier',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(() => proofFencesCase(url))
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
    for (const path of ['/api/conversations', '/api/agent/resident', '/api/mcp/servers'])
      expect((await call(base, invitee, path)).status).toBe(403)
    await lever(base, invitee, 'revoke')
    expect((await state(base, invitee)).active).toBeNull()
    expect((await call(base, invitee, '/api/conversations')).status).toBe(404)
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
  expect((await call(base, owner, '/api/conversations')).status).toBe(200)
  expect((await lever(base, owner, 'delete-fault')).status).toBe(500)
  expect((await state(base, owner)).active).toBeNull()
  expect((await call(base, owner, '/api/conversations')).status).toBe(404)
  expect((await call(base, other, '/api/conversations')).status).toBe(200)
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
  expect((await call(base, inviter, '/api/conversations')).status).toBe(200)
}
harness.test(
  'native Members: owner destruction faults leave access closed; retry and foreign-member deletion preserve owners',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(() => deletionCase(url))
  }),
)

async function invitationCase(base: string) {
  const owner = await person(base)
  await state(base, owner)
  await pay(base, owner)
  const unregistered: Person = { userId: '', cookie: '', ip: owner.ip, email: `${crypto.randomUUID()}@fixture.test` }
  const invitation = await invite(base, owner, unregistered.email)
  expect(
    (
      await call(
        base,
        owner,
        '/api/invitations',
        { email: unregistered.email, role: 'member', policy: NONE, operationId: invitation.operationId },
        MAIL,
      )
    ).status,
  ).toBe(200)
  expect(
    (
      await call(
        base,
        owner,
        '/api/invitations',
        { email: unregistered.email, role: 'viewer', policy: NONE, operationId: invitation.operationId },
        MAIL,
      )
    ).status,
  ).toBe(409)
  const exchange = await proof(base, unregistered, invitation.receipt.id, invitation.fragment)
  expect(exchange.response.status).toBe(200)
  expect(exchange.response.headers.get('referrer-policy')).toBe('no-referrer')
  expect(exchange.response.headers.get('set-cookie')).toContain('HttpOnly')
  expect(
    (
      await call(
        base,
        exchange.person,
        '/api/auth/sign-up/email',
        { email: unregistered.email, name: 'Bypass', password: 'fixture-password-12345' },
        MAIL,
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await call(
        base,
        exchange.person,
        '/api/auth/email-otp/send-verification-otp',
        { email: 'alternate@fixture.test', type: 'sign-in' },
        MAIL,
      )
    ).status,
  ).toBe(403)
  const member = await codeSignIn(base, exchange.person)
  expect((await state(base, member)).workspaces).toEqual([])
  expect((await accept(base, member, invitation.receipt.id)).status).toBe(402)
  await pay(base, member)
  const accepted = await accept(base, member, invitation.receipt.id)
  expect(accepted.status).toBe(200)
  const original = await accepted.json()
  // Apply Set-Cookie exactly as a browser would before retrying a partially observed acceptance response.
  const browserMember = { ...member, cookie: cookiesAfter(member.cookie, accepted) }
  const retried = await accept(base, browserMember, invitation.receipt.id)
  expect(retried.status).toBe(200)
  expect(await retried.json()).toEqual(original)
  const joined = await state(base, member)
  expect(joined.workspaces).toHaveLength(1)
  expect(joined.workspaces[0]).toMatchObject({ role: 'member', agentReady: false })
  expect(joined.active).toBeNull()
  expect(
    (
      await call(base, member, '/api/workspaces/active', {
        workspaceId: joined.workspaces[0]?.id,
        context: joined.context,
      })
    ).status,
  ).toBe(200)
  expect((await roster(base, member)).members).toHaveLength(1)
  expect((await roster(base, member)).invitations).toEqual([])
  expect((await call(base, member, '/api/conversations')).status).toBe(403)
  const administrative = await roster(base, owner)
  const target = administrative.members.find((entry) => entry.userId === member.userId)
  const removed = await fetch(`${base}/api/members/${target?.id}`, {
    method: 'DELETE',
    headers: {
      cookie: owner.cookie,
      origin: 'https://purrable.test',
      'content-type': 'application/json',
      'x-purrable-csrf': '1',
    },
    body: JSON.stringify({ version: target?.version, operationId: crypto.randomUUID() }),
  })
  expect(removed.status).toBe(200)
  expect((await state(base, member)).workspaces).toEqual([])
  expect(await (await accept(base, browserMember, invitation.receipt.id)).json()).toEqual(original)
  expect((await state(base, member)).workspaces).toEqual([])
}
harness.test(
  'native Members: closed signup invitation admits only its verified email and own plan; acceptance replay cannot reactivate removal',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(() => invitationCase(url))
  }),
)

async function rotationCase(base: string) {
  const owner = await person(base)
  await state(base, owner)
  await pay(base, owner)
  const existing = await person(base)
  const invitation = await invite(base, owner, existing.email)
  const old = await proof(base, existing, invitation.receipt.id, invitation.code)
  expect(old.response.status).toBe(200)
  const resend = { version: 1, operationId: crypto.randomUUID() }
  expect((await call(base, owner, `/api/invitations/${invitation.receipt.id}/resend`, resend, MAIL)).status).toBe(200)
  expect((await call(base, owner, `/api/invitations/${invitation.receipt.id}/resend`, resend, MAIL)).status).toBe(200)
  expect(
    (
      await call(
        base,
        old.person,
        '/api/auth/email-otp/send-verification-otp',
        { email: existing.email, type: 'sign-in' },
        MAIL,
      )
    ).status,
  ).toBe(403)
  expect((await proof(base, existing, invitation.receipt.id, invitation.fragment)).response.status).toBe(403)
  const freshMail = await mail(base, owner, existing.email)
  const fragment = /#([a-f0-9]{64})/u.exec(freshMail.text)?.[1] ?? ''
  const fresh = await proof(base, existing, invitation.receipt.id, fragment)
  expect(fresh.response.status).toBe(200)
  expect(
    (
      await call(
        base,
        owner,
        `/api/invitations/${invitation.receipt.id}/revoke`,
        { version: 1, operationId: crypto.randomUUID() },
        MAIL,
      )
    ).status,
  ).toBe(409)
  expect(
    (
      await call(
        base,
        owner,
        `/api/invitations/${invitation.receipt.id}/revoke`,
        { version: 2, operationId: crypto.randomUUID() },
        MAIL,
      )
    ).status,
  ).toBe(200)
  expect(
    (
      await call(
        base,
        fresh.person,
        '/api/auth/email-otp/send-verification-otp',
        { email: existing.email, type: 'sign-in' },
        MAIL,
      )
    ).status,
  ).toBe(403)
  const expiring = await invite(base, owner, `${crypto.randomUUID()}@fixture.test`)
  await lever(base, owner, 'expire', { invitationId: expiring.receipt.id })
  expect((await proof(base, existing, expiring.receipt.id, expiring.fragment)).response.status).toBe(404)
}
harness.test(
  'native Members: code/link proof, resend rotation, revoked OTP admission and version/expiry fences',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(() => rotationCase(url))
  }),
)
