import { expect } from 'vitest'
import * as Schema from 'effect/Schema'
import { ConversationView, TopicView } from '@goblin/contracts'
import { call, ownerFetch, person, waitFor, type Person } from './owner-requests.ts'

const decodeTopic = Schema.decodeUnknownSync(TopicView)
const decodeTopics = Schema.decodeUnknownSync(Schema.Array(TopicView))
const decodeView = Schema.decodeUnknownSync(ConversationView)
const decodeViews = Schema.decodeUnknownSync(Schema.Array(ConversationView))
const decodeSessions = Schema.decodeUnknownSync(Schema.Struct({ sessions: Schema.Number }))
const decodeEntries = Schema.decodeUnknownSync(
  Schema.Struct({ entries: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.Number, kind: Schema.String }))) }),
)

const patch = (url: string, owner: Person, path: string, body: unknown) =>
  ownerFetch(`${url}${path}`, {
    method: 'PATCH',
    headers: {
      cookie: owner.cookie,
      origin: 'https://goblin.test',
      'x-goblin-csrf': '1',
      'content-type': 'application/json',
      'cf-connecting-ip': owner.ip,
    },
    body: JSON.stringify(body),
  })
const send = (url: string, owner: Person, chat: string, input: string) =>
  call(url, owner, `/api/conversations/${chat}/messages`, { input, operationId: crypto.randomUUID() })
const snapshot = async (url: string, owner: Person, chat: string) =>
  (await call(url, owner, `/api/conversations/${chat}/snapshot`)).text()
/** Every Pi session in the owner's agent, to prove a create made exactly one. */
const sessions = async (url: string, owner: Person) =>
  decodeSessions(await (await call(url, owner, '/__test/topics/sessions')).json()).sessions
const views = async (url: string, owner: Person) =>
  decodeViews(await (await call(url, owner, '/api/conversations')).json())
const held = async (url: string, owner: Person) => (await call(url, owner, '/__test/queue/held')).text()

/** Until the queue model no longer holds `input`: its run ended (Stop aborts a held generation). */
async function released(url: string, owner: Person, input: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await held(url, owner)).includes(input)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`still held: ${input}`)
}

/** Creating is idempotent by operation id, even concurrently: one Topic, one Conversation, one new Pi session. */
async function createOnce(url: string, owner: Person): Promise<TopicView> {
  const before = await sessions(url, owner)
  const operationId = crypto.randomUUID()
  const [first, second] = await Promise.all(
    [0, 1].map(async () => call(url, owner, '/api/topics', { name: ' Garden ', operationId })),
  )
  expect([first?.status, second?.status]).toEqual([201, 201])
  const topic = decodeTopic(await first?.json())
  expect(decodeTopic(await second?.json())).toEqual(topic)
  expect(decodeTopic(await (await call(url, owner, '/api/topics', { name: 'Garden', operationId })).json())).toEqual(
    topic,
  )
  expect(topic).toMatchObject({ name: 'Garden', createdBy: 'owner', searchExcluded: false, revision: 1 })
  const clash = await call(url, owner, '/api/topics', { name: 'GARDEN', operationId: crypto.randomUUID() })
  expect(clash.status).toBe(409)
  expect(await sessions(url, owner)).toBe(before + 1)
  const channels = (await views(url, owner)).filter((view) => view.conversation === true)
  expect(channels.map((view) => [view.id, view.topic, view.title])).toEqual([
    ['1', 1, undefined],
    [topic.conversation, topic.id, 'Garden'],
  ])
  return topic
}

/** A Topic's Conversation answers on its own; its threads inherit the Topic and announce themselves there. */
async function workIn(url: string, owner: Person, topic: TopicView): Promise<string> {
  const channel = topic.conversation
  for (const change of [{ closed: true }, { title: 'Renamed directly' }])
    expect((await patch(url, owner, `/api/conversations/${channel}`, change)).status).toBe(400)
  expect((await send(url, owner, channel, 'hello garden')).status).toBe(202)
  await waitFor(url, owner, `/api/conversations/${channel}/snapshot`, 'echo: hello garden')
  expect(await snapshot(url, owner, '1')).not.toContain('hello garden')
  const empty = decodeView(await (await call(url, owner, '/api/conversations', { topic: topic.id })).json())
  expect(empty).toMatchObject({ kind: 'thread', topic: topic.id, parent: channel })
  expect(empty.conversation).toBeUndefined()
  expect((await patch(url, owner, `/api/conversations/${empty.id}`, { title: 'Seed plan' })).status).toBe(200)
  expect((await send(url, owner, empty.id, 'plan the seeds')).status).toBe(202)
  await waitFor(url, owner, `/api/conversations/${channel}/snapshot`, 'Seed plan')
  expect(await snapshot(url, owner, '1')).not.toContain('Seed plan')
  const entry = (decodeEntries(JSON.parse(await snapshot(url, owner, channel))).entries ?? []).findLast(
    ({ kind }) => kind === 'pi.assistant',
  )?.id
  const branched = decodeView(
    await (await call(url, owner, '/api/conversations', { from: { conversation: channel, entry } })).json(),
  )
  expect(branched).toMatchObject({ kind: 'thread', topic: topic.id, parent: channel })
  return empty.id
}

/** Archive stops a held run and refuses new work; restore starts nothing again; Personal is never archived. */
async function archiveAndRestore(url: string, owner: Person, topic: TopicView, thread: string): Promise<void> {
  const channel = topic.conversation
  const hold = `queue-hold:topic-${topic.id}`
  expect((await send(url, owner, channel, hold)).status).toBe(202)
  await waitFor(url, owner, '/__test/queue/held', hold)
  const archived = await patch(url, owner, `/api/topics/${topic.id}`, { archived: true })
  expect(archived.status).toBe(200)
  expect(decodeTopic(await archived.json())).toMatchObject({
    id: topic.id,
    revision: 2,
    archivedAt: expect.any(Number),
  })
  await released(url, owner, hold)
  for (const chat of [channel, thread]) expect((await send(url, owner, chat, 'while archived')).status).toBe(400)
  expect((await call(url, owner, '/api/conversations', { topic: topic.id })).status).toBe(400)
  const restored = decodeTopic(await (await patch(url, owner, `/api/topics/${topic.id}`, { archived: false })).json())
  expect(restored.archivedAt).toBeUndefined()
  expect(await held(url, owner)).not.toContain(hold)
  expect(await snapshot(url, owner, channel)).not.toContain(`echo: ${hold}`)
  expect((await send(url, owner, channel, 'back again')).status).toBe(202)
  await waitFor(url, owner, `/api/conversations/${channel}/snapshot`, 'echo: back again')
  expect((await patch(url, owner, '/api/topics/1', { archived: true })).status).toBe(400)
  const personal = decodeTopics(await (await call(url, owner, '/api/topics')).json()).find((each) => each.id === 1)
  expect(personal).toMatchObject({ personal: true, conversation: '1' })
  expect(personal?.archivedAt).toBeUndefined()
}

export async function topicsCase(url: string): Promise<void> {
  const owner = await person(url)
  const other = await person(url)
  for (const who of [owner, other])
    await call(url, who, '/__test/billing/override', { userId: who.userId, dailyCredits: 1000 })
  expect(decodeTopics(await (await call(url, owner, '/api/topics')).json())).toEqual([
    expect.objectContaining({ id: 1, name: 'Personal', conversation: '1', personal: true }),
  ])
  const topic = await createOnce(url, owner)
  const thread = await workIn(url, owner, topic)
  await archiveAndRestore(url, owner, topic, thread)
  // An inbound client still talks in Personal's Conversation, never in the Topic the owner used last.
  const inbound = await call(url, owner, '/__test/topics/inbound', {
    input: 'inbound lands in personal',
    operationId: crypto.randomUUID(),
  })
  expect(inbound.status).toBe(200)
  expect(await snapshot(url, owner, '1')).toContain('inbound lands in personal')
  expect(await snapshot(url, owner, topic.conversation)).not.toContain('inbound lands in personal')
  // Another account sees only its own Personal, and cannot reach the owner's Topic.
  expect(decodeTopics(await (await call(url, other, '/api/topics')).json()).map((each) => each.id)).toEqual([1])
  expect((await patch(url, other, `/api/topics/${topic.id}`, { name: 'Taken over' })).status).toBe(404)
}
