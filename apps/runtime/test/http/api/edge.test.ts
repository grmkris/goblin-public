import { BillingRefused, NotFound, SubscriptionRequired, Unauthenticated, envelopeOf } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { describe, expect, it } from 'vitest'
import { type AccountRecords, crashPoint } from '../../../src/http/api/account.ts'
import { type Edge, isAccountPath, makeEdgeHttp } from '../../../src/http/api/edge.ts'
import { attempt } from '../../../src/http/errors.ts'
import { FlowPointFailure } from '../../../src/observability/ae.ts'
import { withLines } from '../../observability/lines.ts'

const APP = 'https://goblin.test'
const OWNER = 'user-owner'
const PLAN_LESS = 'user-plan-less'
const SECRET = 'secret-words'
const STATE = {
  active: false,
  source: 'none',
  until: null,
  dailyCredits: 0,
  status: 'none',
  hasCustomer: false,
  cancelAtPeriodEnd: false,
  mode: null,
  plan: null,
  priceCents: 1000,
} as const

/** The account's records, keeping the crash points asked for: each one's user, if the report came with a session. */
const accountRecords = (crash: AccountRecords['crash'] = () => Effect.void) => {
  const crashes: (string | undefined)[] = []
  const records: AccountRecords = {
    clients: () => Effect.succeed([{ clientId: 'client.1', name: 'Claude' }]),
    revokeClient: () => Effect.void,
    billingState: () => Effect.succeed(STATE),
    checkout: () => Effect.fail(new BillingRefused({ code: 'already_subscribed' })),
    portal: () => Effect.succeed({ url: 'https://portal.test/x' }),
    walletStart: () => Effect.succeed({ signUrl: 'https://wallet.test/subscribe/x' }),
    walletConfirm: () => Effect.fail(new BillingRefused({ code: 'subscription_unsigned' })),
    crash: (report, userId) => {
      crashes.push(Option.getOrUndefined(userId))
      return crash(report, userId)
    },
  }
  return { records, crashes }
}

/** The deployment as the edge sees it, with an agent that records what reached it and answers `reply`. */
const deployment = (
  reply: () => Response = () => Response.json({ ok: true }),
  { records, crashes } = accountRecords(),
) => {
  const seen: Request[] = []
  const edge: Edge = {
    origin: APP,
    session: (request) => {
      const cookie = request.headers.get('cookie')
      if (request.headers.has('authorization') || cookie === null)
        return Effect.fail(new Unauthenticated({ reason: 'session required' }))
      return Effect.succeed(cookie === 'session=plan-less' ? PLAN_LESS : OWNER)
    },
    plan: (userId) =>
      userId === OWNER ? Effect.void : Effect.fail(new SubscriptionRequired({ subscribe: '/subscribe' })),
    agent: () => ({
      fetch: async (request) => {
        seen.push(request)
        return reply()
      },
    }),
    records,
  }
  return { seen, edge, crashes }
}

const built = Effect.runPromise(makeEdgeHttp)
/** One request through the edge: its response and the lines it logged. */
const through = async (
  side: 'account' | 'owner',
  request: Request,
  edge: Edge,
): Promise<{ readonly response: Response; readonly lines: readonly unknown[] }> => {
  const http = await built
  const { value, lines } = await Effect.runPromise(withLines(http[side](request, edge)))
  return { response: value, lines: lines.map(({ line }) => line) }
}

const write = (path: string, init: { headers?: Record<string, string>; body?: BodyInit; method?: string } = {}) =>
  new Request(`${APP}${path}`, {
    method: init.method ?? 'POST',
    headers: { cookie: 'session=owner', origin: APP, 'x-goblin-csrf': '1', ...init.headers },
    ...(init.body === undefined ? {} : { body: init.body }),
  })

describe('the owner forward', () => {
  it('forwards only the allowlisted headers, with the edge reference and the owner mark, and never a credential', async () => {
    const { seen, edge } = deployment()
    const request = write('/api/mcp/myplan/tools/call?x=1', {
      headers: {
        'cf-ray': '8c1f2a3b4d5e6f70-AMS',
        'content-type': 'application/json',
        'x-goblin-request': 'r1b2c3d4',
        'x-goblin-operation': 'op-1',
        'x-mcp-caller': 'app',
        'x-goblin-ref': 'forged',
        'x-goblin-forwarded': 'forged',
      },
      body: JSON.stringify({ name: 'x' }),
    })
    const { response } = await through('owner', request, edge)
    expect(response.headers.get('x-goblin-ref')).toBe('8c1f2a3b4d5e6f70-AMS')
    const [forwarded] = seen
    expect(forwarded?.url).toBe('https://agent/api/mcp/myplan/tools/call?x=1')
    expect(forwarded?.method).toBe('POST')
    expect(Object.fromEntries(forwarded?.headers ?? [])).toEqual({
      'content-type': 'application/json',
      'x-goblin-request': 'r1b2c3d4',
      'x-goblin-operation': 'op-1',
      'x-mcp-caller': 'app',
      'x-goblin-ref': '8c1f2a3b4d5e6f70-AMS',
      'x-goblin-forwarded': 'owner',
    })
    expect(await forwarded?.json()).toEqual({ name: 'x' })
  })

  // Whatever a path says, the agent sees only `/api/*` as the parsed URL names it, marked as the owner's forward: an
  // internal path never reaches it from the owner's session (the agent refuses a marked one too, `internal.test.ts`).
  it.each([
    ['/internal/x', 404],
    ['/api/../internal/x', 404],
    ['/api/%2e%2e/internal/x', 404],
    ['/api/%2E%2E/internal/x', 404],
    ['/api/.%2e/internal/x', 404],
    ['//../internal/x', 404],
    ['/API/internal/x', 404],
    ['/api%2Finternal/x', 404],
    ['/api\\..\\internal\\x', 404],
    ['/api/billing/state', 404],
    ['/api/internal/x', 200],
    ['/api/%2F..%2Finternal/x', 200],
  ] as const)('forwards %s only under /api/ and marked as the owner', async (path, status) => {
    const { seen, edge } = deployment()
    const request = new Request(`${APP}${path}`, {
      headers: { cookie: 'session=owner', 'x-goblin-forwarded': 'internal' },
    })
    const { response } = await through('owner', request, edge)
    expect(response.status).toBe(status)
    if (status === 404) expect(await response.json()).toMatchObject({ error: { code: 'not_found', what: 'route' } })
    for (const forwarded of seen) {
      expect(new URL(forwarded.url).pathname).toMatch(/^\/api\//u)
      expect(forwarded.headers.get('x-goblin-forwarded')).toBe('owner')
    }
    expect(seen).toHaveLength(status === 404 ? 0 : 1)
  })

  it("hands the agent's redirect to the browser instead of following it into the agent", async () => {
    const connected = `${APP}/connections?connected=sidequest`
    const { seen, edge } = deployment(() => new Response(null, { status: 302, headers: { location: connected } }))
    const request = new Request(`${APP}/api/mcp/oauth/callback?state=s&code=c`, {
      headers: { cookie: 'session=owner' },
    })
    const { response } = await through('owner', request, edge)
    expect(seen.map((forwarded) => forwarded.redirect)).toEqual(['manual'])
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(connected)
  })

  it('makes up a reference where there is no cf-ray', async () => {
    const { seen, edge } = deployment()
    await through('owner', new Request(`${APP}/api/topics`, { headers: { cookie: 'session=owner' } }), edge)
    expect(seen[0]?.headers.get('x-goblin-ref')).toMatch(/^[0-9a-f]{16}$/u)
  })

  it.each([
    ['no session', new Request(`${APP}/api/topics`), 401, 'unauthenticated'],
    [
      'a bearer token beside the cookie',
      new Request(`${APP}/api/topics`, { headers: { cookie: 'session=owner', authorization: 'Bearer x' } }),
      401,
      'unauthenticated',
    ],
    [
      'a write without the CSRF header',
      write('/api/topics/7', { method: 'PATCH', headers: { 'x-goblin-csrf': '' } }),
      403,
      'forbidden',
    ],
    ['a write from another site', write('/api/topics', { headers: { origin: 'https://evil.test' } }), 403, 'forbidden'],
    [
      'an account without a plan',
      new Request(`${APP}/api/topics`, { headers: { cookie: 'session=plan-less' } }),
      402,
      'subscription_required',
    ],
  ] as const)('refuses %s without waking the agent', async (_case, request, status, code) => {
    const { seen, edge } = deployment()
    const { response } = await through('owner', request, edge)
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ error: { code } })
    expect(seen).toHaveLength(0)
  })

  it('refuses a JSON body over 64 KB without waking the agent, but streams a file upload through', async () => {
    const { seen, edge } = deployment()
    const big = 'x'.repeat(70_000)
    const { response } = await through(
      'owner',
      write('/api/topics', { body: big, headers: { 'cf-ray': 'ray-413' } }),
      edge,
    )
    expect(response.status).toBe(413)
    expect(response.headers.get('x-goblin-ref')).toBe('ray-413')
    expect(await response.json()).toMatchObject({ error: { code: 'payload_too_large', limit: 65_536, ref: 'ray-413' } })
    expect(seen).toHaveLength(0)
    await through('owner', write('/api/files/uploads/a.txt', { method: 'PUT', body: big }), edge)
    expect(await seen[0]?.text()).toHaveLength(70_000)
  })

  it('logs one content-free line for a failure the agent answered, naming the endpoint and the agent', async () => {
    const { edge } = deployment(() =>
      Response.json(envelopeOf(new NotFound({ what: SECRET, ref: 'ray-1' })), { status: 404 }),
    )
    const request = write('/api/topics/7', {
      method: 'PATCH',
      headers: { 'cf-ray': 'ray-1', 'x-goblin-request': 'r1', 'x-goblin-operation': 'op-1' },
      body: JSON.stringify({ name: SECRET }),
    })
    const { response, lines } = await through('owner', request, edge)
    expect(response.status).toBe(404)
    expect(lines).toEqual([
      {
        level: 'info',
        event: 'http.failure',
        route: 'topics.update',
        method: 'PATCH',
        status: 404,
        code: 'not_found',
        ref: 'ray-1',
        request: 'r1',
        operation: 'op-1',
        agent: OWNER,
      },
    ])
    expect(JSON.stringify(lines)).not.toContain(SECRET)
  })

  it('names a path that is no endpoint by its area only', async () => {
    const { edge } = deployment()
    const { lines } = await through('owner', new Request(`${APP}/api/agent-apps/${SECRET}/nothing`), edge)
    expect(lines).toMatchObject([{ route: '/api/agent-apps/{path}', status: 401, code: 'unauthenticated' }])
    expect(JSON.stringify(lines)).not.toContain(SECRET)
  })
})

describe('the account API in the Worker', () => {
  const report = {
    route: '/c/$chatId',
    name: 'TypeError',
    frames: ['https://goblin.test/assets/index-3f2a.js?v=1:1:2345'],
    build: 'd5ac526',
    ref: '7f3a9c12',
  }

  it('takes a crash report with the CSRF header and no session, and logs it without its query', async () => {
    const { edge, crashes } = deployment()
    const request = new Request(`${APP}/api/client-errors`, {
      method: 'POST',
      headers: { origin: APP, 'x-goblin-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify(report),
    })
    const { response, lines } = await through('account', request, edge)
    expect(response.status).toBe(204)
    expect(crashes).toEqual([undefined])
    expect(lines).toEqual([
      {
        level: 'warn',
        event: 'client_error',
        route: '/c/$chatId',
        name: 'TypeError',
        frames: ['https://goblin.test/assets/index-3f2a.js:1:2345'],
        build: 'd5ac526',
        ref: '7f3a9c12',
      },
    ])
  })

  it("writes a signed-in report's point under its user, and still takes a report whose point cannot be written", async () => {
    const body = JSON.stringify(report)
    const signedIn = deployment()
    const withSession = write('/api/client-errors', { headers: { 'content-type': 'application/json' }, body })
    expect((await through('account', withSession, signedIn.edge)).response.status).toBe(204)
    expect(signedIn.crashes).toEqual([OWNER])
    const failing = deployment(
      undefined,
      accountRecords(() => Effect.fail(new FlowPointFailure({ step: 'write', cause: 'x' }))),
    )
    const { response, lines } = await through(
      'account',
      write('/api/client-errors', { headers: { 'content-type': 'application/json' }, body }),
      failing.edge,
    )
    expect(response.status).toBe(204)
    expect(lines).toContainEqual(
      expect.objectContaining({ event: 'failure', where: 'http.clientErrors', 'error.type': 'FlowPointFailure' }),
    )
  })

  it("puts a crash's point in the flow layout: content-free, indexed by the agent's hash only when there is one", () => {
    const point = crashPoint(report, 'a1b2c3d4e5f60718', 'dev')
    expect(point).toEqual({
      indexes: ['a1b2c3d4e5f60718'],
      blobs: ['client_error', 'app', 'owner', '', 'error', 'TypeError', 'dev', 'd5ac526', ''],
      doubles: [1, 0, 0, 0],
    })
    expect(crashPoint(report, undefined, 'dev').indexes).toEqual([])
    expect(JSON.stringify(point)).not.toContain('/c/')
    expect(JSON.stringify(point)).not.toContain('index-3f2a')
  })

  it('refuses a crash report without the CSRF header, or one that could carry a message', async () => {
    const { edge } = deployment()
    const json = { 'content-type': 'application/json' }
    const forged = write('/api/client-errors', {
      headers: { ...json, 'x-goblin-csrf': '' },
      body: JSON.stringify(report),
    })
    expect((await through('account', forged, edge)).response.status).toBe(403)
    const message = write('/api/client-errors', {
      headers: json,
      body: JSON.stringify({ ...report, name: `Cannot read ${SECRET}` }),
    })
    const { response, lines } = await through('account', message, edge)
    expect(response.status).toBe(400)
    expect(JSON.stringify(lines)).not.toContain(SECRET)
    const big = write('/api/client-errors', { headers: json, body: 'x'.repeat(5000) })
    expect((await through('account', big, edge)).response.status).toBe(413)
  })

  it('answers billing for an account without a plan, and its refusals in the envelope with the reference', async () => {
    const { edge } = deployment()
    const plan = new Request(`${APP}/api/billing/state`, { headers: { cookie: 'session=plan-less' } })
    expect(await (await through('account', plan, edge)).response.json()).toEqual(STATE)
    const { response } = await through(
      'account',
      write('/api/billing/checkout', { headers: { 'cf-ray': 'ray-9' } }),
      edge,
    )
    expect(response.status).toBe(409)
    expect(response.headers.get('x-goblin-ref')).toBe('ray-9')
    expect(await response.json()).toEqual({
      error: { code: 'already_subscribed', message: 'You already have Pro.', ref: 'ray-9' },
    })
  })

  it('answers clients only for an account with a plan, and revokes one', async () => {
    const { edge } = deployment()
    const planLess = new Request(`${APP}/api/clients`, { headers: { cookie: 'session=plan-less' } })
    expect((await through('account', planLess, edge)).response.status).toBe(402)
    const list = new Request(`${APP}/api/clients`, { headers: { cookie: 'session=owner' } })
    expect(await (await through('account', list, edge)).response.json()).toEqual([
      { clientId: 'client.1', name: 'Claude' },
    ])
    const revoke = write('/api/clients/client.1', { method: 'DELETE' })
    expect(await (await through('account', revoke, edge)).response.json()).toEqual({ revoked: true })
    const forged = write('/api/clients/client.1', { method: 'DELETE', headers: { 'x-goblin-csrf': '' } })
    expect((await through('account', forged, edge)).response.status).toBe(403)
  })

  it('owns its paths: anything else under them is a 404 in the envelope', async () => {
    expect(['/api/billing/state', '/api/clients/x', '/api/client-errors'].every(isAccountPath)).toBe(true)
    expect(['/api/billing-x', '/api/topics', '/api/clientsx'].some(isAccountPath)).toBe(false)
    const { edge } = deployment()
    const { response } = await through('account', new Request(`${APP}/api/billing`), edge)
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'not_found' } })
  })
})

describe("the Worker's own routes", () => {
  const route = async (request: Request, serve: () => Promise<Response>) => {
    const http = await built
    const { value, lines } = await Effect.runPromise(withLines(http.route(request, () => attempt(serve))))
    return { response: value, lines: lines.map(({ line }) => line) }
  }

  it('answers with the API headers and the reference', async () => {
    const request = new Request(`${APP}/mcp`, { method: 'POST', headers: { 'cf-ray': 'ray-4' } })
    const { response, lines } = await route(request, async () => Response.json({ ok: true }))
    expect(response.status).toBe(200)
    expect(response.headers.get('x-goblin-ref')).toBe('ray-4')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(lines).toEqual([])
  })

  it('answers a failure of ours as the internal envelope, its line naming only the route area', async () => {
    const request = new Request(`${APP}/hooks/myagent/${SECRET}/token`, {
      method: 'POST',
      headers: { 'cf-ray': 'ray-5' },
    })
    const { response, lines } = await route(request, () => Promise.reject(new Error(`token=${SECRET}`)))
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: {
        code: 'internal',
        message: 'Something went wrong on our side.',
        recovery: 'Try again.',
        reason: 'unexpected',
        ref: 'ray-5',
      },
    })
    expect(lines).toContainEqual({
      level: 'error',
      event: 'http.failure',
      route: '/hooks/myagent/{path}',
      method: 'POST',
      status: 500,
      code: 'internal',
      ref: 'ray-5',
    })
    expect(JSON.stringify(lines)).not.toContain(SECRET)
  })

  it('answers a typed refusal in its envelope, logged as information', async () => {
    const request = new Request(`${APP}/internal/recent`, { headers: { 'cf-ray': 'ray-6' } })
    const { response, lines } = await route(request, () => Promise.reject(new NotFound({ what: 'route' })))
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'not_found', what: 'route', ref: 'ray-6' } })
    expect(lines).toMatchObject([{ level: 'info', route: '/internal/recent', status: 404, code: 'not_found' }])
  })
})
