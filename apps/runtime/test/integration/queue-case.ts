import { expect } from 'vitest'
import * as Schema from 'effect/Schema'
import { type AgentFetch, callOwner } from '../owner-client.ts'
import {
  call,
  grantPlan,
  holding,
  lever,
  ownerFetch,
  person,
  showing,
  signedIn,
  type Person,
} from './owner-requests.ts'
import { answerOf, ownerSnapshot } from './probe-reads.ts'

const active = Schema.decodeUnknownSync(Schema.Struct({ run: Schema.Struct({ inputs: Schema.Array(Schema.Int) }) }))
const submit = (me: AgentFetch, id: string, input: string) =>
  callOwner(me, (api) =>
    api.conversations.submit({ params: { id }, payload: { input, operationId: crypto.randomUUID() } }),
  )
const remove = async (me: AgentFetch, id: string, submissionId: number) =>
  (await callOwner(me, (api) => api.conversations.removeQueued({ params: { id }, payload: { submissionId } }))).status
const queue = async (me: AgentFetch, id: string) =>
  (await callOwner(me, (api) => api.conversations.queue({ params: { id } }))).inputs
const snapshot = async (me: AgentFetch, id: string) => active(await ownerSnapshot(me, id))
const release = async (url: string, owner: Person, input: string) => {
  const response = await lever(url, owner, 'queue/release', { input })
  expect(await response.json()).toEqual({ released: true })
}

async function conversationCase(url: string, owner: Person, other: Person, id: string) {
  const me = signedIn(url, owner)
  const them = signedIn(url, other)
  const first = `queue-hold:${id}-first`
  const next = `queue-hold:${id}-next`
  expect(await submit(me, id, first)).toMatchObject({ accepted: true })
  await holding(url, owner, first)
  const live = (await snapshot(me, id)).run.inputs[0]
  if (live === undefined) throw new Error('missing live native input')
  expect(await submit(me, id, 'private queued input')).toMatchObject({ accepted: true })
  expect(await submit(me, id, next)).toMatchObject({ accepted: true })
  const queued = await queue(me, id)
  expect(queued.map(({ content }) => content)).toEqual(['private queued input', next])
  const target = queued[0]?.id
  const following = queued[1]?.id
  if (target === undefined || following === undefined) throw new Error('missing queued native inputs')
  expect(await queue(them, '1')).toEqual([])
  expect(await remove(them, '1', target)).toBe('not_found')
  // A selector for the owner's agent, in the query and a header, still reaches the caller's own.
  const selected = await call(url, other, `/api/conversations/1/queue?agent=${owner.userId}`, undefined, {
    'x-goblin-workspace': owner.userId,
  })
  expect(selected.status).toBe(200)
  expect(await answerOf(me, (api) => api.conversations.queue({ params: { id: '999999' } }))).toBe('NotFound')
  const another = await callOwner(me, (api) => api.conversations.create({ payload: {} }))
  expect(await remove(me, another.id, target)).toBe('not_found')
  expect(await remove(me, id, target)).toBe('removed')
  expect(await remove(me, id, target)).toBe('already_settled')
  expect((await snapshot(me, id)).run.inputs).toEqual([live])
  expect((await queue(me, id)).map(({ id: queuedId }) => queuedId)).toEqual([following])
  await release(url, owner, first)
  await holding(url, owner, next)
  expect(await remove(me, id, following)).toBe('already_started')
  expect((await snapshot(me, id)).run.inputs).toEqual([following])
  await release(url, owner, next)
  const completed = await showing(me, id, `echo: ${next}`)
  expect(completed).not.toContain('private queued input')
  expect(await remove(me, id, following)).toBe('already_settled')
  expect(await queue(me, id)).toEqual([])
  const stopped = `queue-hold:${id}-stop`
  await submit(me, id, stopped)
  await holding(url, owner, stopped)
  await submit(me, id, 'withdrawn by Stop')
  expect(await queue(me, id)).toHaveLength(1)
  await callOwner(me, (api) => api.conversations.stop({ params: { id }, payload: {} }))
  expect(await queue(me, id)).toEqual([])
}

/** A raw `DELETE …/queue` of `body`, as `who` with `headers`: what the typed client would not send. */
const deleteQueued = (url: string, who: Person, body: unknown, headers: Record<string, string>) =>
  ownerFetch(`${url}/api/conversations/1/queue`, {
    method: 'DELETE',
    headers: { cookie: who.cookie, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

export async function queueCase(url: string): Promise<void> {
  const owner = await person(url)
  const other = await person(url)
  for (const who of [owner, other]) await grantPlan(url, who)
  await conversationCase(url, owner, other, '1')
  const thread = await callOwner(signedIn(url, owner), (api) => api.conversations.create({ payload: {} }))
  await conversationCase(url, owner, other, thread.id)
  const browser = { origin: 'https://goblin.test', 'x-goblin-csrf': '1' }
  for (const submissionId of [0, -1, 1.5, '5', Number.MAX_SAFE_INTEGER + 1])
    expect((await deleteQueued(url, owner, { submissionId }, browser)).status).toBe(400)
  for (const headers of [
    {},
    { origin: 'https://goblin.test' },
    { 'x-goblin-csrf': '1' },
    { origin: 'https://evil.example', 'x-goblin-csrf': '1' },
  ])
    expect((await deleteQueued(url, owner, { submissionId: 1 }, headers)).status).toBe(403)
}
