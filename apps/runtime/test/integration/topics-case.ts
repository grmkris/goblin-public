import { expect } from 'vitest'
import * as Schema from 'effect/Schema'
import type { TopicView } from '@goblin/contracts'
import { type AgentFetch, callOwner } from '../owner-client.ts'
import {
  grantPlan,
  holding,
  lever,
  person,
  released,
  showing,
  signedIn,
  snapshotText,
  workspaceOf,
  type Person,
} from './owner-requests.ts'
import { answerOf, ownerResult, ownerSnapshot } from './probe-reads.ts'

const decodeSessions = Schema.decodeUnknownSync(Schema.Struct({ sessions: Schema.Number }))
const decodeEntries = Schema.decodeUnknownSync(
  Schema.Struct({ entries: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.Number, kind: Schema.String }))) }),
)

/** The owner's message into `chat`, as the owner API answered it. */
const send = (me: AgentFetch, chat: string, input: string) =>
  answerOf(me, (api) =>
    api.conversations.submit({ params: { id: chat }, payload: { input, operationId: crypto.randomUUID() } }),
  )
/** Every Pi session in the owner's agent, to prove a create made exactly one. */
const sessions = async (url: string, owner: Person) =>
  decodeSessions(await (await lever(url, owner, 'topics/sessions')).json()).sessions
const views = async (url: string, owner: Person) => (await workspaceOf(url, owner)).conversations
const topics = async (url: string, who: Person) => (await workspaceOf(url, who)).topics ?? []
const createTopic = (me: AgentFetch, name: string, operationId: string) =>
  callOwner(me, (api) => api.topics.create({ payload: { name, operationId } }))

/** Creating is idempotent by operation id, even concurrently: one Topic, one Conversation, one new Pi session. */
async function createOnce(url: string, owner: Person): Promise<TopicView> {
  const me = signedIn(url, owner)
  const before = await sessions(url, owner)
  const operationId = crypto.randomUUID()
  const [topic, second] = await Promise.all([0, 1].map(async () => createTopic(me, ' Garden ', operationId)))
  expect(second).toEqual(topic)
  expect(await createTopic(me, 'Garden', operationId)).toEqual(topic)
  expect(topic).toMatchObject({ name: 'Garden', createdBy: 'owner', searchExcluded: false, revision: 1 })
  // A Topic starts with everything (ADR 0040); the catalog it is chosen from has no server, skill or app yet.
  expect(topic?.setup).toEqual({ mcpServers: 'all', skills: 'all', apps: 'all', subagents: true })
  expect(await callOwner(me, (api) => api.setup.catalog())).toEqual({ servers: [], libraries: [], apps: [] })
  const clash = await answerOf(me, (api) =>
    api.topics.create({ payload: { name: 'GARDEN', operationId: crypto.randomUUID() } }),
  )
  expect(clash).toBe('Conflict')
  expect(await sessions(url, owner)).toBe(before + 1)
  const channels = (await views(url, owner)).filter((view) => view.conversation === true)
  if (topic === undefined) throw new Error('no topic created')
  expect(channels.map((view) => [view.id, view.topic, view.title])).toEqual([
    ['1', 1, undefined],
    [topic.conversation, topic.id, 'Garden'],
  ])
  return topic
}

/** A Topic's Conversation answers on its own; its threads inherit the Topic and announce themselves there. */
async function workIn(url: string, owner: Person, topic: TopicView): Promise<string> {
  const me = signedIn(url, owner)
  const channel = topic.conversation
  for (const change of [{ closed: true }, { title: 'Renamed directly' }])
    expect(await answerOf(me, (api) => api.conversations.update({ params: { id: channel }, payload: change }))).toBe(
      'InvalidInput',
    )
  expect(await send(me, channel, 'hello garden')).toBe('ok')
  await showing(me, channel, 'echo: hello garden')
  expect(await snapshotText(me, '1')).not.toContain('hello garden')
  const empty = await callOwner(me, (api) => api.conversations.create({ payload: { topic: topic.id } }))
  expect(empty).toMatchObject({ kind: 'thread', topic: topic.id, parent: channel })
  expect(empty.conversation).toBeUndefined()
  await callOwner(me, (api) => api.conversations.update({ params: { id: empty.id }, payload: { title: 'Seed plan' } }))
  expect(await send(me, empty.id, 'plan the seeds')).toBe('ok')
  await showing(me, channel, 'Seed plan')
  expect(await snapshotText(me, '1')).not.toContain('Seed plan')
  const entry = (decodeEntries(await ownerSnapshot(me, channel)).entries ?? []).findLast(
    ({ kind }) => kind === 'pi.assistant',
  )?.id
  if (entry === undefined) throw new Error('no answer in the channel')
  const branched = await callOwner(me, (api) =>
    api.conversations.create({ payload: { from: { conversation: channel, entry } } }),
  )
  expect(branched).toMatchObject({ kind: 'thread', topic: topic.id, parent: channel })
  return empty.id
}

/** Archive stops a held run and refuses new work; restore starts nothing again; Personal is never archived. */
async function archiveAndRestore(url: string, owner: Person, topic: TopicView, thread: string): Promise<void> {
  const me = signedIn(url, owner)
  const channel = topic.conversation
  const hold = `queue-hold:topic-${topic.id}`
  expect(await send(me, channel, hold)).toBe('ok')
  await holding(url, owner, hold)
  const archived = await callOwner(me, (api) =>
    api.topics.update({ params: { id: topic.id }, payload: { archived: true } }),
  )
  expect(archived).toMatchObject({ id: topic.id, revision: 2, archivedAt: expect.any(Number) })
  await released(url, owner, hold)
  for (const chat of [channel, thread]) expect(await send(me, chat, 'while archived')).toBe('InvalidInput')
  expect(await answerOf(me, (api) => api.conversations.create({ payload: { topic: topic.id } }))).toBe('InvalidInput')
  const restored = await callOwner(me, (api) =>
    api.topics.update({ params: { id: topic.id }, payload: { archived: false } }),
  )
  expect(restored.archivedAt).toBeUndefined()
  expect(await (await lever(url, owner, 'queue/held')).text()).not.toContain(hold)
  expect(await snapshotText(me, channel)).not.toContain(`echo: ${hold}`)
  expect(await send(me, channel, 'back again')).toBe('ok')
  await showing(me, channel, 'echo: back again')
  expect(await answerOf(me, (api) => api.topics.update({ params: { id: 1 }, payload: { archived: true } }))).toBe(
    'InvalidInput',
  )
  const personal = (await topics(url, owner)).find((each) => each.id === 1)
  expect(personal).toMatchObject({ personal: true, conversation: '1' })
  expect(personal?.archivedAt).toBeUndefined()
}

export async function topicsCase(url: string): Promise<void> {
  const owner = await person(url)
  const other = await person(url)
  for (const who of [owner, other]) await grantPlan(url, who)
  expect(await topics(url, owner)).toEqual([
    expect.objectContaining({ id: 1, name: 'Personal', conversation: '1', personal: true }),
  ])
  const topic = await createOnce(url, owner)
  const thread = await workIn(url, owner, topic)
  await archiveAndRestore(url, owner, topic, thread)
  // An inbound client still talks in Personal's Conversation, never in the Topic the owner used last.
  const inbound = await lever(url, owner, 'topics/inbound', {
    input: 'inbound lands in personal',
    operationId: crypto.randomUUID(),
  })
  expect(inbound.status).toBe(200)
  const me = signedIn(url, owner)
  expect(await snapshotText(me, '1')).toContain('inbound lands in personal')
  expect(await snapshotText(me, topic.conversation)).not.toContain('inbound lands in personal')
  // Another account sees only its own Personal, and cannot reach the owner's Topic.
  expect((await topics(url, other)).map((each) => each.id)).toEqual([1])
  const takenOver = await ownerResult(signedIn(url, other), (api) =>
    api.topics.update({ params: { id: topic.id }, payload: { name: 'Taken over' } }),
  )
  expect(takenOver).toMatchObject({ ok: false, error: { _tag: 'NotFound' } })
}
