import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import { Effect, Schema } from 'effect'
import { createHash } from 'node:crypto'
import { expect } from 'vitest'
import Stack from './auth-stack.ts'
import { person, call } from './owner-requests.ts'

const harness = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
  stage: 'test_auth',
  dev: true,
})
const stack = harness.beforeAll(harness.deploy(Stack))
const SEND = '/email-otp/send-verification-otp'
const SIGN_IN = '/sign-in/email-otp'
const Mail = Schema.Struct({
  code: Schema.String,
  row: Schema.NullOr(Schema.Struct({ value: Schema.String, createdAt: Schema.Unknown, expiresAt: Schema.Unknown })),
})
function browser(base: string) {
  const ip = `2001:db8:${Array.from(crypto.getRandomValues(new Uint16Array(4)), (n) => n.toString(16)).join(':')}:0:1`
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
    fetch(`${base}/api/auth${path}`, {
      method: 'POST',
      headers: { origin: 'https://goblin.test', 'content-type': 'application/json', 'cf-connecting-ip': ip, ...extra },
      body: JSON.stringify(body),
    })
  return { post, email: `${crypto.randomUUID()}@fixture.test` }
}
const mailFor = async (base: string, email: string) =>
  Schema.decodeUnknownSync(Mail)(
    await (await fetch(`${base}/__test/auth/mail?email=${encodeURIComponent(email)}`)).json(),
  )
const lever = (base: string, action: string, email: string) =>
  fetch(`${base}/__test/auth/${action}?email=${encodeURIComponent(email)}`)

async function codeCase(base: string) {
  const { post, email } = browser(base)
  expect((await post(SEND, { email: ` ${email.toUpperCase()} `, type: 'sign-in' })).status).toBe(200)
  const mail = await mailFor(base, email)
  expect(mail.code).toMatch(/^\d{6}$/u)
  expect(mail.row?.value).not.toContain(mail.code)
  expect((await post(SEND, { email, type: 'sign-in' })).status).toBe(429)
  const result = await post(SIGN_IN, { email, otp: mail.code })
  expect(result.status).toBe(200)
  expect(await result.json()).toMatchObject({ user: { email, emailVerified: true } })
  expect(result.headers.getSetCookie().some((cookie) => cookie.includes('session_token='))).toBe(true)
  expect((await post(SIGN_IN, { email, otp: mail.code })).ok).toBe(false)
  // A known account signs in when signup is closed, without an invite.
  const closed = { 'x-fixture-signup': 'closed' }
  expect((await post(SEND, { email, type: 'sign-in' }, closed)).status).toBe(200)
  expect((await post(SIGN_IN, { email, otp: (await mailFor(base, email)).code }, closed)).status).toBe(200)
}
harness.test(
  'native OTP: canonical email, hashed storage, cooldown, verified account, one use and closed-signup login',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(() => codeCase(url))
  }),
)

async function signupCase(base: string) {
  const { post, email } = browser(base)
  expect((await post(SEND, { email, type: 'sign-in' }, { 'x-fixture-signup': 'closed' })).status).toBe(403)
  const invite = { 'x-fixture-signup': 'invite' }
  expect((await post(SEND, { email, type: 'sign-in' }, invite)).status).toBe(403)
  const admitted = { ...invite, 'x-invite-code': 'fixture-invite' }
  expect((await post(SEND, { email, type: 'sign-in' }, admitted)).status).toBe(200)
  const otp = (await mailFor(base, email)).code
  expect((await post(SIGN_IN, { email, otp }, invite)).status).toBe(403)
  expect((await post(SIGN_IN, { email, otp }, { ...admitted, 'x-fixture-signup': 'closed' })).status).toBe(403)
  expect((await post(SIGN_IN, { email, otp }, admitted)).status).toBe(200)
  const failed = browser(base)
  expect(
    (await failed.post(SEND, { email: failed.email, type: 'sign-in' }, { 'x-fixture-mail-failure': '1' })).ok,
  ).toBe(false)
  expect(await (await lever(base, 'accounts', failed.email)).json()).toMatchObject({ count: 0 })
  expect(await (await lever(base, 'mail', failed.email)).json()).toMatchObject({ row: null })
  expect((await failed.post(SEND, { email: failed.email, type: 'sign-in' })).status).toBe(200)
}
harness.test(
  'native OTP: both send and verify enforce invite/closed policy; mail failure creates no account',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(() => signupCase(url))
  }),
)

async function limitsCase(base: string) {
  const expired = browser(base)
  await expired.post(SEND, { email: expired.email, type: 'sign-in' })
  const otp = (await mailFor(base, expired.email)).code
  await lever(base, 'expire', expired.email)
  expect((await expired.post(SIGN_IN, { email: expired.email, otp })).ok).toBe(false)
  const attempts = browser(base)
  await attempts.post(SEND, { email: attempts.email, type: 'sign-in' })
  const code = (await mailFor(base, attempts.email)).code
  for (let i = 0; i < 5; i++)
    expect(
      (await attempts.post(SIGN_IN, { email: attempts.email, otp: code === '000000' ? '111111' : '000000' })).ok,
    ).toBe(false)
  expect((await attempts.post(SIGN_IN, { email: attempts.email, otp: code })).ok).toBe(false)
  const quota = browser(base)
  for (let i = 0; i < 10; i++)
    expect((await quota.post(SEND, { email: `${i}-${quota.email}`, type: 'sign-in' })).status).toBe(200)
  expect((await quota.post(SEND, { email: `last-${quota.email}`, type: 'sign-in' })).status).toBe(429)
}
harness.test(
  'native OTP: expired codes, five failed attempts and persisted per-IP mail quota refuse login',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(() => limitsCase(url))
  }),
)

async function onlyCodeCase(base: string) {
  const { post, email } = browser(base)
  for (const path of [
    '/sign-up/email',
    '/sign-in/email',
    '/request-password-reset',
    '/reset-password',
    '/send-verification-email',
    '/passkey/verify-authentication',
    '/email-otp/reset-password',
    '/email-otp/change-email',
  ]) {
    expect(
      (
        await post(path, {
          email,
          name: 'fixture',
          password: 'fixture-password-12345',
          newPassword: 'fixture-password-12345',
          token: 'invalid',
          otp: '123456',
          type: 'sign-in',
        })
      ).status,
      path,
    ).toBe(404)
  }
  const who = await person(base)
  expect((await call(base, who, '/api/auth/delete-user', { password: 'unused' })).status).toBe(400)
  await lever(base, 'age-session', who.email)
  expect((await call(base, who, '/api/auth/delete-user', {})).ok).toBe(false)
  const fresh = await person(base)
  expect((await call(base, fresh, '/api/auth/delete-user', {})).status).toBe(200)
  expect((await call(base, fresh, '/api/conversations')).status).toBe(401)
}
harness.test(
  'native OTP only: removed account methods return 404; deletion requires a fresh code session',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(() => onlyCodeCase(url))
  }),
)

async function oauthCase(base: string) {
  const { post, email } = browser(base)
  const registered = await post('/oauth2/register', {
    client_name: 'otp-continuation-fixture',
    redirect_uris: ['http://127.0.0.1:9/callback'],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'],
    response_types: ['code'],
  })
  expect(registered.status).toBe(201)
  const client = Schema.decodeUnknownSync(Schema.Struct({ client_id: Schema.String }))(await registered.json())
  const verifier = crypto.randomUUID() + crypto.randomUUID()
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: 'http://127.0.0.1:9/callback',
    scope: 'openid',
    resource: 'https://goblin.test/mcp',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'fixture',
  })
  const authorize = await fetch(`${base}/api/auth/oauth2/authorize?${query.toString()}`, {
    redirect: 'manual',
    headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
  })
  const location = authorize.headers.get('location')
  let loginUrl: URL
  if (authorize.status === 200) {
    const result = Schema.decodeUnknownSync(Schema.Struct({ redirect: Schema.Literal(true), url: Schema.String }))(
      await authorize.json(),
    )
    loginUrl = new URL(result.url, 'https://goblin.test')
  } else {
    expect(authorize.status).toBe(302)
    loginUrl = new URL(location ?? '', 'https://goblin.test')
  }
  expect(loginUrl.pathname).toBe('/login')
  const oauth_query = loginUrl.search.slice(1)
  expect((await post(SEND, { email, type: 'sign-in', oauth_query })).status).toBe(200)
  const signedIn = await post(SIGN_IN, { email, otp: (await mailFor(base, email)).code, oauth_query })
  expect(signedIn.status).toBe(200)
  const result = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(await signedIn.json())
  expect(new URL(result.url, 'https://goblin.test').pathname).toBe('/consent')
  expect(result.url).toContain(client.client_id)
}
harness.test(
  'native OTP: inbound OAuth authorization resumes at owner consent after code login',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(() => oauthCase(url))
  }),
)
