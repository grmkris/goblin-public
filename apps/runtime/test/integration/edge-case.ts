import * as Schema from 'effect/Schema'
import { request as httpRequest } from 'node:http'
import { expect } from 'vitest'
import { hookToken } from '../../src/channel/doorbell.ts'
import { eventsHookToken } from '../../src/mcp/events/route-token.ts'
import { callOwner } from '../owner-client.ts'
import { call, grantPlan, ownerFetch, person, signedIn, workspaceOf, type Person } from './owner-requests.ts'

const APP = 'https://goblin.test'
const Detail = Schema.Struct({ error: Schema.Struct({ code: Schema.String, ref: Schema.optional(Schema.String) }) })
const decodeDetail = Schema.decodeUnknownSync(Detail)

/** A browser crash report as the web posts it: same origin and the CSRF header, no session. */
const report = (url: string, body: string, headers: Record<string, string> = {}) =>
  ownerFetch(`${url}/api/client-errors`, {
    method: 'POST',
    headers: { origin: APP, 'x-goblin-csrf': '1', 'content-type': 'application/json', ...headers },
    body,
  })

/** A failure's envelope: its code, and whether it quotes the reference the response carries. */
const refusalOf = async (response: Response) => {
  const { error } = decodeDetail(await response.json())
  return { status: response.status, code: error.code, quoted: error.ref === response.headers.get('x-goblin-ref') }
}

/**
 * `/api/client-errors` (ADR 0024): a content-free report is taken without a session and answered with no body; one
 * that could carry a message (a message for a name, a URL with a query for a route, free text for a frame) or one
 * over 2 KiB is refused, and so is a report without the CSRF header. The Worker's log line is checked content-free by
 * the unit tests (`test/http/api/edge.test.ts`).
 */
export async function clientErrorsCase(url: string): Promise<void> {
  const valid = {
    route: '/c/$chatId',
    name: 'TypeError',
    frames: ['https://goblin.test/assets/index-3f2a.js:1:2345'],
    build: 'd5ac526',
  }
  const taken = await report(url, JSON.stringify(valid))
  expect(taken.status).toBe(204)
  expect(await taken.text()).toBe('')
  expect(taken.headers.get('x-goblin-ref')).not.toBeNull()
  const secret = `secret-${crypto.randomUUID()}`
  for (const carrying of [
    { ...valid, name: `Cannot read ${secret}` },
    { ...valid, route: `/c/1?q=${secret}` },
    { ...valid, frames: [`${secret} words`] },
    {
      ...valid,
      message: secret,
      frames: Array.from({ length: 12 }, () => `https://goblin.test/${'a'.repeat(200)}.js:1:2`),
    },
  ]) {
    const refused = await report(url, JSON.stringify(carrying))
    expect(await refusalOf(refused)).toMatchObject({ status: 400, code: 'invalid_input', quoted: true })
  }
  const forged = await report(url, JSON.stringify(valid), { 'x-goblin-csrf': '' })
  expect(await refusalOf(forged)).toMatchObject({ status: 403, code: 'forbidden', quoted: true })
  const huge = await report(url, JSON.stringify({ ...valid, build: 'x'.repeat(5000) }))
  expect(await refusalOf(huge)).toMatchObject({ status: 413, code: 'payload_too_large' })
}

/** A signed-in owner's write as `init` makes it, without `call`'s CSRF header. */
const write = (
  url: string,
  who: Person,
  path: string,
  init: { method: string; body: unknown; headers: Record<string, string> },
) =>
  ownerFetch(`${url}${path}`, {
    method: init.method,
    headers: { cookie: who.cookie, 'cf-connecting-ip': who.ip, 'content-type': 'application/json', ...init.headers },
    body: JSON.stringify(init.body),
  })

/**
 * CSRF on every write: an owner write without the `x-goblin-csrf` header, or from another origin, is refused 403 at the
 * Worker's edge in the envelope and never reaches the agent; the same write with it goes through, and a read needs
 * none. The account API (inbound clients) refuses it the same way.
 */
export async function csrfCase(url: string): Promise<void> {
  const owner = await person(url)
  await grantPlan(url, owner)
  const name = `Forged ${crypto.randomUUID().slice(0, 8)}`
  const topic = { name, operationId: crypto.randomUUID() }
  for (const headers of [
    { origin: APP },
    { origin: APP, 'x-goblin-csrf': '0' },
    { origin: 'https://evil.test', 'x-goblin-csrf': '1' },
  ]) {
    const refused = await write(url, owner, '/api/topics', { method: 'POST', body: topic, headers })
    expect(await refusalOf(refused)).toMatchObject({ status: 403, code: 'forbidden', quoted: true })
  }
  const revoke = await write(url, owner, '/api/clients/no-such-client', {
    method: 'DELETE',
    body: {},
    headers: { origin: APP },
  })
  expect(await refusalOf(revoke)).toMatchObject({ status: 403, code: 'forbidden' })
  const topics = async () => (await workspaceOf(url, owner)).topics ?? []
  expect((await topics()).some((each) => each.name === name)).toBe(false)
  const created = await write(url, owner, '/api/topics', {
    method: 'POST',
    body: topic,
    headers: { origin: APP, 'x-goblin-csrf': '1' },
  })
  expect(created.status).toBe(201)
  expect((await topics()).some((each) => each.name === name)).toBe(true)
}

/** The owner stack's credential key (`owner-stack.ts`): the hook tokens are made from it. */
const CREDENTIAL_KEY = 'Z29ibGluLXRlc3QtZml4dHVyZS1rZXkhISEhISEhISE='

/**
 * A GET of `path` exactly as written. `fetch` (and a browser) resolves `..` and `%2e%2e` before it sends anything; a
 * raw client need not, so this is what one sends.
 */
const rawGet = (base: string, path: string, headers: Record<string, string>) =>
  new Promise<{ readonly status: number; readonly body: string }>((resolve, reject) => {
    const { hostname, port } = new URL(base)
    const sent = httpRequest({ hostname, port, path, headers: { ...headers, connection: 'close' } }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        body += chunk
      })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
    })
    sent.on('error', reject)
    sent.end()
  })

/** A hook as its sender posts it to the real Worker: myagent's doorbell or an MCP Events webhook. */
const hook = (url: string, path: string, headers: Record<string, string>, body: string) =>
  ownerFetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })

/**
 * The agent's internal API from outside the Worker (`/internal/*`): nobody reaches it, signed in or not, whatever the
 * path says on the way. The Worker's own callers still do: a doorbell with its user's route token reaches the agent,
 * which refuses it without a plan (402) and checks myagent's signature with one (403, no channel here); an Events
 * webhook reaches ingress, which ends the subscription once resident authority is off (410).
 */
export async function internalRefusalCase(url: string): Promise<void> {
  const outside = await ownerFetch(`${url}/internal/recent?limit=5`, { headers: { 'cf-ray': 'ray-internal' } })
  expect(await refusalOf(outside)).toMatchObject({ status: 404, code: 'not_found', quoted: true })
  const owner = await person(url)
  const session = { cookie: owner.cookie, 'cf-connecting-ip': owner.ip }
  for (const path of ['/api/%2e%2e/internal/recent?limit=5', '/api/%2E%2E/internal/inspect', '/api/../internal/recent'])
    expect(await rawGet(url, path, session)).toMatchObject({ status: 404, body: expect.stringContaining('not_found') })
  const doorbell = `/hooks/myagent/${owner.userId}/${await hookToken(CREDENTIAL_KEY, owner.userId)}`
  const ring = () =>
    hook(url, doorbell, { 'x-myagent-timestamp': String(Date.now()), 'x-myagent-signature': 'x' }, '{"cursor":"0"}')
  expect(await refusalOf(await ring())).toMatchObject({ status: 402, code: 'subscription_required' })
  await grantPlan(url, owner)
  expect(await refusalOf(await ring())).toMatchObject({ status: 403, code: 'forbidden', quoted: true })
  await callOwner(signedIn(url, owner), (api) => api.resident.set({ payload: { enabled: false } }))
  const webhook = await hook(
    url,
    `/hooks/mcp-events/${owner.userId}/${await eventsHookToken(CREDENTIAL_KEY, owner.userId)}`,
    { 'x-mcp-subscription-id': 'remote-1', 'webhook-id': 'msg_1', 'webhook-timestamp': '0', 'webhook-signature': '' },
    '{}',
  )
  expect(webhook.status).toBe(410)
}

/** The text of the server-sent events on `response` so far: `until` reads on until `seen` holds or `ms` pass. */
function eventText(response: Response) {
  const reader = response.body?.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const until = async (seen: (text: string) => boolean, ms: number): Promise<string> => {
    if (reader === undefined) return text
    const deadline = Date.now() + ms
    while (!seen(text) && Date.now() < deadline) {
      const timeout = new Promise<undefined>((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())))
      const read = await Promise.race([reader.read(), timeout])
      if (read === undefined || read.done) break
      text += decoder.decode(read.value, { stream: true })
    }
    return text
  }
  return { until, close: () => reader?.cancel() }
}

/**
 * A chat's event stream through the real Worker stays open past the request that opened it: its snapshot first, then
 * the batch Pi commits when the owner sends a message afterwards.
 */
export async function conversationEventsCase(url: string): Promise<void> {
  const owner = await person(url)
  await grantPlan(url, owner)
  const stream = await call(url, owner, '/api/conversations/1/events')
  expect(stream.status).toBe(200)
  expect(stream.headers.get('content-type')).toBe('text/event-stream')
  const events = eventText(stream)
  try {
    expect(await events.until((text) => text.includes('event: snapshot'), 5000)).toContain('event: snapshot')
    const sent = await callOwner(signedIn(url, owner), (api) =>
      api.conversations.submit({ params: { id: '1' }, payload: { input: 'hello stream', operationId: 'sse-1' } }),
    )
    expect(sent).toMatchObject({ accepted: true })
    expect(await events.until((text) => text.includes('event: batch'), 10_000)).toContain('event: batch')
  } finally {
    await events.close()
  }
}
