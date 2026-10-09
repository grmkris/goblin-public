import { TopicView } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { expect } from 'vitest'
import { call, ownerFetch, person, type Person } from './owner-requests.ts'

const APP = 'https://goblin.test'
const Detail = Schema.Struct({ error: Schema.Struct({ code: Schema.String, ref: Schema.optional(Schema.String) }) })
const decodeDetail = Schema.decodeUnknownSync(Detail)
const decodeTopics = Schema.decodeUnknownSync(Schema.Array(TopicView))

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
  await call(url, owner, '/__test/billing/override', { userId: owner.userId, dailyCredits: 1000 })
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
  const listed = await call(url, owner, '/api/topics')
  expect(listed.status).toBe(200)
  expect(decodeTopics(await listed.json()).some((each) => each.name === name)).toBe(false)
  const created = await write(url, owner, '/api/topics', {
    method: 'POST',
    body: topic,
    headers: { origin: APP, 'x-goblin-csrf': '1' },
  })
  expect(created.status).toBe(201)
  expect(decodeTopics(await (await call(url, owner, '/api/topics')).json()).some((each) => each.name === name)).toBe(
    true,
  )
}
