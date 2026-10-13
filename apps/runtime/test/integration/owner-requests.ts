import type { WorkspaceSnapshot } from '@goblin/contracts'
import { expect } from 'vitest'
import { Schema } from 'effect'
import { type AgentFetch, workspaceSnapshot } from '../owner-client.ts'
import { ownerSnapshot } from './probe-reads.ts'
import { waitFor } from './until.ts'

const Signup = Schema.Struct({ user: Schema.Struct({ id: Schema.String }) })
export interface Person {
  readonly userId: string
  readonly cookie: string
  readonly ip: string
  readonly email: string
}

/** The owner stack's app (`APP_URL`): the web's requests come from its origin. */
const APP = 'https://goblin.test'

/** Workerd can close a retained HTTP socket; each fixture request gets its own connection. */
export const ownerFetch = (url: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set('connection', 'close')
  return fetch(url, { ...init, headers })
}
export async function person(base: string): Promise<Person> {
  const ip = `2001:db8:${Array.from(crypto.getRandomValues(new Uint16Array(4)), (n) => n.toString(16)).join(':')}:0:1`
  const email = `${crypto.randomUUID()}@fixture.test`
  const headers = { origin: APP, 'content-type': 'application/json', 'cf-connecting-ip': ip }
  const sent = await ownerFetch(`${base}/api/auth/email-otp/send-verification-otp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, type: 'sign-in' }),
  })
  expect(sent.status).toBe(200)
  const mail = Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }))(
    await (await ownerFetch(`${base}/__test/auth/mail?email=${encodeURIComponent(email)}`)).json(),
  )
  const response = await ownerFetch(`${base}/api/auth/sign-in/email-otp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, otp: mail.code }),
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

/** What `who`'s browser sends with every request: their session cookie, the app's origin, the CSRF header and their address. */
const browserHeaders = (who: Person) => ({
  cookie: who.cookie,
  origin: APP,
  'content-type': 'application/json',
  'x-goblin-csrf': '1',
  'cf-connecting-ip': who.ip,
})

/**
 * One request of `who`'s browser to `path` on the Worker at `base`, exactly as written: a GET, or a POST of `body` as
 * JSON. For what the typed client cannot say (an edge refusal's status, the auth routes, the test levers).
 */
export const call = (base: string, who: Person, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  ownerFetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...browserHeaders(who), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

/**
 * The owner API as `who`'s browser reaches it: through the Worker at `base`, with what `call` sends, and `headers` on
 * top. It stands where an agent's `fetch` does, so the typed client (`callOwner`, `ownerResult`) and the reads of
 * `probe-reads.ts` take it.
 */
export const signedIn = (base: string, who: Person, headers: Record<string, string> = {}): AgentFetch => ({
  fetch: async (request) => {
    const { pathname, search } = new URL(request.url)
    const sent = new Headers(request.headers)
    for (const [name, value] of Object.entries({ ...browserHeaders(who), ...headers })) sent.set(name, value)
    const body = request.method === 'GET' || request.method === 'HEAD' ? {} : { body: await request.arrayBuffer() }
    return ownerFetch(`${base}${pathname}${search}`, { method: request.method, headers: sent, ...body })
  },
})

/** A test lever of the owner stack's Worker (`/__test/<name>`), as `who`: a GET, or a POST of `body`. */
export const lever = (base: string, who: Person, name: string, body?: unknown) =>
  call(base, who, `/__test/${name}`, body)

/** Gives `who` a plan (an override of `dailyCredits` a day), so their agent takes turns (ADR 0054). */
export const grantPlan = async (base: string, who: Person, dailyCredits = 1000): Promise<void> => {
  await lever(base, who, 'billing/override', { userId: who.userId, dailyCredits })
}

/** The inputs the queue model holds now, as its lever's text. */
const heldText = async (base: string, who: Person) => (await lever(base, who, 'queue/held')).text()

/** How long the owner cases wait for a turn to reach a state: the queue model, the snapshot, the workspace. */
const SETTLE_MS = 10_000

/** Until the queue model holds `input`. */
export const holding = (base: string, who: Person, input: string) =>
  waitFor(
    () => heldText(base, who),
    (held) => held.includes(input),
    `${input} held`,
    SETTLE_MS,
  )

/** Until the queue model no longer holds `input`: its run ended (Stop aborts a held generation). */
export const released = (base: string, who: Person, input: string) =>
  waitFor(
    () => heldText(base, who),
    (held) => !held.includes(input),
    `${input} released`,
    SETTLE_MS,
  )

/** `chat`'s Pi snapshot as JSON text, through the typed client. */
export const snapshotText = async (agent: AgentFetch, chat: string) => JSON.stringify(await ownerSnapshot(agent, chat))

/** Until `chat`'s snapshot holds `expected`; its text then. */
export const showing = (agent: AgentFetch, chat: string, expected: string) =>
  waitFor(
    () => snapshotText(agent, chat),
    (text) => text.includes(expected),
    `${expected} in chat ${chat}`,
    SETTLE_MS,
  )

/** The workspace feed's snapshot as `who` sees it (`GET /api/workspace/events`, or `path` with `headers`). */
export const workspaceOf = async (
  base: string,
  who: Person,
  path = '/api/workspace/events',
  headers: Record<string, string> = {},
): Promise<WorkspaceSnapshot> => workspaceSnapshot(await call(base, who, path, undefined, headers))

/** The workspace feed's snapshot once `done` holds for it. */
export const workspaceUntil = (base: string, who: Person, done: (snapshot: WorkspaceSnapshot) => boolean) =>
  waitFor(() => workspaceOf(base, who), done, 'the workspace state', SETTLE_MS)
