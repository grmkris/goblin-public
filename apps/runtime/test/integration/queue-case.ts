import { expect } from 'vitest'
import * as Schema from 'effect/Schema'
import { ConversationQueue, ConversationView, QueueRemovalResult } from '@goblin/contracts'
import { person, call, ownerFetch, waitFor, type Person } from './owner-requests.ts'

const decodeQueue = Schema.decodeUnknownSync(ConversationQueue)
const decodeRemoval = Schema.decodeUnknownSync(QueueRemovalResult)
const active = Schema.decodeUnknownSync(Schema.Struct({ run: Schema.Struct({ inputs: Schema.Array(Schema.Int) }) }))
const submit = (url: string, owner: Person, id: string, input: string) =>
  call(url, owner, `/api/conversations/${id}/messages`, {
    input,
    operationId: crypto.randomUUID(),
  })
const remove = async (url: string, owner: Person, thread: string, submissionId: number) => {
  const response = await ownerFetch(`${url}/api/conversations/${thread}/queue`, {
    method: 'DELETE',
    headers: {
      cookie: owner.cookie,
      origin: 'https://goblin.test',
      'x-goblin-csrf': '1',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ submissionId }),
  })
  expect(response.status).toBe(200)
  return decodeRemoval(await response.json()).status
}
const queue = async (url: string, owner: Person, id: string) => {
  const response = await call(url, owner, `/api/conversations/${id}/queue`)
  expect(response.status).toBe(200)
  return decodeQueue(await response.json()).inputs
}
const snapshot = async (url: string, owner: Person, id: string) =>
  active(await (await call(url, owner, `/api/conversations/${id}/snapshot`)).json())
const release = async (url: string, owner: Person, input: string) => {
  const response = await call(url, owner, '/__test/queue/release', { input })
  expect(await response.json()).toEqual({ released: true })
}

async function conversationCase(url: string, owner: Person, other: Person, id: string) {
  const first = `queue-hold:${id}-first`
  const next = `queue-hold:${id}-next`
  expect((await submit(url, owner, id, first)).status).toBe(202)
  await waitFor(url, owner, '/__test/queue/held', first)
  const live = (await snapshot(url, owner, id)).run.inputs[0]
  if (live === undefined) throw new Error('missing live native input')
  expect((await submit(url, owner, id, 'private queued input')).status).toBe(202)
  expect((await submit(url, owner, id, next)).status).toBe(202)
  const queued = await queue(url, owner, id)
  expect(queued.map(({ content }) => content)).toEqual(['private queued input', next])
  const target = queued[0]?.id
  const following = queued[1]?.id
  if (target === undefined || following === undefined) throw new Error('missing queued native inputs')
  expect(await queue(url, other, '1')).toEqual([])
  expect(await remove(url, other, '1', target)).toBe('not_found')
  expect(
    (
      await call(url, other, `/api/conversations/1/queue?agent=${owner.userId}`, undefined, {
        'x-goblin-workspace': owner.userId,
      })
    ).status,
  ).toBe(200)
  expect((await call(url, owner, '/api/conversations/999999/queue')).status).toBe(404)
  const another = Schema.decodeUnknownSync(ConversationView)(
    await (await call(url, owner, '/api/conversations', {})).json(),
  )
  expect(await remove(url, owner, another.id, target)).toBe('not_found')
  expect(await remove(url, owner, id, target)).toBe('removed')
  expect(await remove(url, owner, id, target)).toBe('already_settled')
  expect((await snapshot(url, owner, id)).run.inputs).toEqual([live])
  expect((await queue(url, owner, id)).map(({ id: queuedId }) => queuedId)).toEqual([following])
  await release(url, owner, first)
  await waitFor(url, owner, '/__test/queue/held', next)
  expect(await remove(url, owner, id, following)).toBe('already_started')
  expect((await snapshot(url, owner, id)).run.inputs).toEqual([following])
  await release(url, owner, next)
  const completed = await waitFor(url, owner, `/api/conversations/${id}/snapshot`, `echo: ${next}`)
  expect(completed).not.toContain('private queued input')
  expect(await remove(url, owner, id, following)).toBe('already_settled')
  expect(await queue(url, owner, id)).toEqual([])
  const stopped = `queue-hold:${id}-stop`
  await submit(url, owner, id, stopped)
  await waitFor(url, owner, '/__test/queue/held', stopped)
  await submit(url, owner, id, 'withdrawn by Stop')
  expect(await queue(url, owner, id)).toHaveLength(1)
  expect((await call(url, owner, `/api/conversations/${id}/stop`, {})).status).toBe(200)
  expect(await queue(url, owner, id)).toEqual([])
}

export async function queueCase(url: string): Promise<void> {
  const owner = await person(url)
  const other = await person(url)
  for (const who of [owner, other])
    await call(url, who, '/__test/billing/override', { userId: who.userId, dailyCredits: 1000 })
  await conversationCase(url, owner, other, '1')
  const thread = Schema.decodeUnknownSync(ConversationView)(
    await (await call(url, owner, '/api/conversations', {})).json(),
  )
  await conversationCase(url, owner, other, thread.id)
  for (const submissionId of [0, -1, 1.5, '5', Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = await ownerFetch(`${url}/api/conversations/1/queue`, {
      method: 'DELETE',
      headers: {
        cookie: owner.cookie,
        origin: 'https://goblin.test',
        'x-goblin-csrf': '1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ submissionId }),
    })
    expect(invalid.status).toBe(400)
  }
  for (const headers of [
    {},
    { origin: 'https://goblin.test' },
    { 'x-goblin-csrf': '1' },
    { origin: 'https://evil.example', 'x-goblin-csrf': '1' },
  ]) {
    const refused = await ownerFetch(`${url}/api/conversations/1/queue`, {
      method: 'DELETE',
      headers: { cookie: owner.cookie, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ submissionId: 1 }),
    })
    expect(refused.status).toBe(403)
  }
}
