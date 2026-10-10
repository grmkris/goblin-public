import { expect } from 'vitest'
import * as Schema from 'effect/Schema'
import { ConversationView, ThreadHeadData, TopicView } from '@goblin/contracts'
import { call, ownerFetch, person, waitFor, workspaceOf, type Person } from './owner-requests.ts'

const Started = Schema.Struct({
  thread: ConversationView,
  receipt: Schema.Struct({ operationId: Schema.String, session: Schema.String, accepted: Schema.Boolean }),
})
const decodeStarted = Schema.decodeUnknownSync(Started)
const decodeTopic = Schema.decodeUnknownSync(TopicView)
const Snapshot = Schema.Struct({
  entries: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.Finite,
        kind: Schema.String,
        data: Schema.optional(Schema.Unknown),
        model: Schema.optional(Schema.Unknown),
      }),
    ),
  ),
})
const decodeSnapshot = Schema.decodeUnknownSync(Snapshot)
const decodeHead = Schema.decodeUnknownSync(ThreadHeadData)

/** Start thread from `chat`'s composer: the unified thread operation at the chat's newest settled entry. */
const start = (url: string, owner: Person, chat: string, input: string, operationId: string) =>
  call(url, owner, `/api/conversations/${chat}/threads`, { operationId, anchor: 'latest', message: { input } })
const send = (url: string, owner: Person, chat: string, input: string) =>
  call(url, owner, `/api/conversations/${chat}/messages`, { input, operationId: crypto.randomUUID() })
const entries = async (url: string, owner: Person, chat: string) =>
  decodeSnapshot(await (await call(url, owner, `/api/conversations/${chat}/snapshot`)).json()).entries ?? []
/** The thread heads written into `chat`, decoded. */
const heads = async (url: string, owner: Person, chat: string) =>
  (await entries(url, owner, chat)).filter((entry) => entry.kind === 'app.thread_head')
const threadCount = async (url: string, owner: Person) => (await workspaceOf(url, owner)).conversations.length

/** A started Thread: forked from the channel, its head in the channel, the owner's message answered in the Thread. */
async function headAndInput(url: string, owner: Person): Promise<void> {
  expect((await send(url, owner, '1', 'hello channel')).status).toBe(202)
  await waitFor(url, owner, '/api/conversations/1/snapshot', 'echo: hello channel')
  const before = await threadCount(url, owner)
  const operationId = crypto.randomUUID()
  const response = await start(url, owner, '1', 'plan the trip', operationId)
  expect(response.status).toBe(201)
  const { thread, receipt } = decodeStarted(await response.json())
  expect(thread).toMatchObject({ kind: 'thread', parent: '1', topic: 1 })
  expect(thread.forkEntry).toBeTypeOf('number')
  expect(receipt).toMatchObject({ operationId: `${operationId}:first`, accepted: true })
  await waitFor(url, owner, `/api/conversations/${thread.id}/snapshot`, 'echo: plan the trip')
  const channel = await heads(url, owner, '1')
  expect(channel.map((entry) => decodeHead(entry.data))).toEqual([
    { thread: thread.id, text: 'plan the trip', operationId },
  ])
  expect(JSON.stringify(channel[0]?.model)).toContain('[the owner started a thread: \\"plan the trip\\"]')
  const channelText = JSON.stringify(await entries(url, owner, '1'))
  expect(channelText).not.toContain('echo: plan the trip')
  // The Thread forked the channel as it was, so it knows what was said there before.
  expect(JSON.stringify(await entries(url, owner, thread.id))).toContain('hello channel')
  // A retry, sequential or concurrent, finds the same Thread, head and message.
  const retried = decodeStarted(await (await start(url, owner, '1', 'plan the trip', operationId)).json())
  expect(retried.thread.id).toBe(thread.id)
  expect(retried.receipt).toMatchObject({ operationId: `${operationId}:first`, accepted: false })
  const concurrent = crypto.randomUUID()
  const pair = await Promise.all([0, 1].map(async () => start(url, owner, '1', 'twice at once', concurrent)))
  expect(pair.map((each) => each.status)).toEqual([201, 201])
  const [first, second] = await Promise.all(pair.map(async (each) => decodeStarted(await each.json())))
  expect(first?.thread.id).toBe(second?.thread.id)
  expect([first?.receipt.accepted, second?.receipt.accepted].filter(Boolean)).toHaveLength(1)
  expect(await threadCount(url, owner)).toBe(before + 2)
  await waitFor(url, owner, `/api/conversations/${first?.thread.id ?? ''}/snapshot`, 'echo: twice at once')
  expect((await heads(url, owner, '1')).map((entry) => decodeHead(entry.data).operationId)).toEqual([
    operationId,
    concurrent,
  ])
  const thread2 = await entries(url, owner, first?.thread.id ?? '')
  expect(thread2.filter((entry) => JSON.stringify(entry.model ?? '').includes('echo: twice at once'))).toHaveLength(1)
  // The operation belongs to the chat it started in; another chat cannot reuse it.
  expect((await start(url, owner, thread.id, 'elsewhere', operationId)).status).toBe(409)
  expect((await start(url, owner, '1', '   ', crypto.randomUUID())).status).toBe(400)
}

/** A chat that is still answering forks before the running turn; an empty chat starts an empty Thread in its Topic. */
async function runningAndEmpty(url: string, owner: Person): Promise<void> {
  const hold = 'queue-hold:thread-head'
  expect((await send(url, owner, '1', hold)).status).toBe(202)
  await waitFor(url, owner, '/__test/queue/held', hold)
  const busy = decodeStarted(await (await start(url, owner, '1', 'while busy', crypto.randomUUID())).json())
  await waitFor(url, owner, `/api/conversations/${busy.thread.id}/snapshot`, 'echo: while busy')
  expect(JSON.stringify(await entries(url, owner, busy.thread.id))).not.toContain(hold)
  expect((await call(url, owner, '/__test/queue/release', { input: hold })).status).toBe(200)
  await waitFor(url, owner, '/api/conversations/1/snapshot', `echo: ${hold}`)
  const topic = decodeTopic(
    await (await call(url, owner, '/api/topics', { name: 'Thread heads', operationId: crypto.randomUUID() })).json(),
  )
  const empty = decodeStarted(
    await (await start(url, owner, topic.conversation, 'first words', crypto.randomUUID())).json(),
  )
  expect(empty.thread).toMatchObject({ kind: 'thread', parent: topic.conversation, topic: topic.id })
  expect(empty.thread.forkEntry).toBeUndefined()
  await waitFor(url, owner, `/api/conversations/${empty.thread.id}/snapshot`, 'echo: first words')
  expect(await heads(url, owner, topic.conversation)).toHaveLength(1)
  expect(JSON.stringify(await entries(url, owner, '1'))).not.toContain('first words')
  // A closed Thread starts none.
  const closed = await ownerFetch(`${url}/api/conversations/${empty.thread.id}`, {
    method: 'PATCH',
    headers: {
      cookie: owner.cookie,
      origin: 'https://goblin.test',
      'x-goblin-csrf': '1',
      'content-type': 'application/json',
      'cf-connecting-ip': owner.ip,
    },
    body: JSON.stringify({ closed: true }),
  })
  expect(closed.status).toBe(200)
  expect((await start(url, owner, empty.thread.id, 'after close', crypto.randomUUID())).status).toBe(400)
}

export async function threadHeadsCase(url: string): Promise<void> {
  const owner = await person(url)
  await call(url, owner, '/__test/billing/override', { userId: owner.userId, dailyCredits: 1000 })
  await headAndInput(url, owner)
  await runningAndEmpty(url, owner)
}
