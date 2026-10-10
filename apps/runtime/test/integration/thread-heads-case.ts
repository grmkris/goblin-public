import { expect } from 'vitest'
import * as Schema from 'effect/Schema'
import { ThreadHeadData } from '@goblin/contracts'
import { type AgentFetch, callOwner } from '../owner-client.ts'
import { grantPlan, holding, lever, person, showing, signedIn, workspaceOf, type Person } from './owner-requests.ts'
import { answerOf, ownerSnapshot } from './probe-reads.ts'

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
const startThread = (chat: string, input: string, operationId: string) => ({
  params: { id: chat },
  payload: { operationId, anchor: 'latest' as const, message: { input } },
})
const start = (me: AgentFetch, chat: string, input: string, operationId: string) =>
  callOwner(me, (api) => api.conversations.startThread(startThread(chat, input, operationId)))
const send = (me: AgentFetch, chat: string, input: string) =>
  callOwner(me, (api) =>
    api.conversations.submit({ params: { id: chat }, payload: { input, operationId: crypto.randomUUID() } }),
  )
const entries = async (me: AgentFetch, chat: string) => decodeSnapshot(await ownerSnapshot(me, chat)).entries ?? []
/** The thread heads written into `chat`, decoded. */
const heads = async (me: AgentFetch, chat: string) =>
  (await entries(me, chat)).filter((entry) => entry.kind === 'app.thread_head')
const threadCount = async (url: string, owner: Person) => (await workspaceOf(url, owner)).conversations.length

/** A started Thread: forked from the channel, its head in the channel, the owner's message answered in the Thread. */
async function headAndInput(url: string, owner: Person): Promise<void> {
  const me = signedIn(url, owner)
  expect(await send(me, '1', 'hello channel')).toMatchObject({ accepted: true })
  await showing(me, '1', 'echo: hello channel')
  const before = await threadCount(url, owner)
  const operationId = crypto.randomUUID()
  const { thread, receipt } = await start(me, '1', 'plan the trip', operationId)
  expect(thread).toMatchObject({ kind: 'thread', parent: '1', topic: 1 })
  expect(thread.forkEntry).toBeTypeOf('number')
  expect(receipt).toMatchObject({ operationId: `${operationId}:first`, accepted: true })
  await showing(me, thread.id, 'echo: plan the trip')
  const channel = await heads(me, '1')
  expect(channel.map((entry) => decodeHead(entry.data))).toEqual([
    { thread: thread.id, text: 'plan the trip', operationId },
  ])
  expect(JSON.stringify(channel[0]?.model)).toContain('[the owner started a thread: \\"plan the trip\\"]')
  const channelText = JSON.stringify(await entries(me, '1'))
  expect(channelText).not.toContain('echo: plan the trip')
  // The Thread forked the channel as it was, so it knows what was said there before.
  expect(JSON.stringify(await entries(me, thread.id))).toContain('hello channel')
  // A retry, sequential or concurrent, finds the same Thread, head and message.
  const retried = await start(me, '1', 'plan the trip', operationId)
  expect(retried.thread.id).toBe(thread.id)
  expect(retried.receipt).toMatchObject({ operationId: `${operationId}:first`, accepted: false })
  const concurrent = crypto.randomUUID()
  const [first, second] = await Promise.all([0, 1].map(async () => start(me, '1', 'twice at once', concurrent)))
  expect(first?.thread.id).toBe(second?.thread.id)
  expect([first?.receipt.accepted, second?.receipt.accepted].filter(Boolean)).toHaveLength(1)
  expect(await threadCount(url, owner)).toBe(before + 2)
  await showing(me, first?.thread.id ?? '', 'echo: twice at once')
  expect((await heads(me, '1')).map((entry) => decodeHead(entry.data).operationId)).toEqual([operationId, concurrent])
  const thread2 = await entries(me, first?.thread.id ?? '')
  expect(thread2.filter((entry) => JSON.stringify(entry.model ?? '').includes('echo: twice at once'))).toHaveLength(1)
  // The operation belongs to the chat it started in; another chat cannot reuse it.
  expect(
    await answerOf(me, (api) => api.conversations.startThread(startThread(thread.id, 'elsewhere', operationId))),
  ).toBe('Conflict')
  const blank = startThread('1', '   ', crypto.randomUUID())
  expect(await answerOf(me, (api) => api.conversations.startThread(blank))).toBe('InvalidInput')
}

/** A chat that is still answering forks before the running turn; an empty chat starts an empty Thread in its Topic. */
async function runningAndEmpty(url: string, owner: Person): Promise<void> {
  const me = signedIn(url, owner)
  const hold = 'queue-hold:thread-head'
  expect(await send(me, '1', hold)).toMatchObject({ accepted: true })
  await holding(url, owner, hold)
  const busy = await start(me, '1', 'while busy', crypto.randomUUID())
  await showing(me, busy.thread.id, 'echo: while busy')
  expect(JSON.stringify(await entries(me, busy.thread.id))).not.toContain(hold)
  expect((await lever(url, owner, 'queue/release', { input: hold })).status).toBe(200)
  await showing(me, '1', `echo: ${hold}`)
  const topic = await callOwner(me, (api) =>
    api.topics.create({ payload: { name: 'Thread heads', operationId: crypto.randomUUID() } }),
  )
  const empty = await start(me, topic.conversation, 'first words', crypto.randomUUID())
  expect(empty.thread).toMatchObject({ kind: 'thread', parent: topic.conversation, topic: topic.id })
  expect(empty.thread.forkEntry).toBeUndefined()
  await showing(me, empty.thread.id, 'echo: first words')
  expect(await heads(me, topic.conversation)).toHaveLength(1)
  expect(JSON.stringify(await entries(me, '1'))).not.toContain('first words')
  // A closed Thread starts none.
  await callOwner(me, (api) => api.conversations.update({ params: { id: empty.thread.id }, payload: { closed: true } }))
  const closed = startThread(empty.thread.id, 'after close', crypto.randomUUID())
  expect(await answerOf(me, (api) => api.conversations.startThread(closed))).toBe('InvalidInput')
}

export async function threadHeadsCase(url: string): Promise<void> {
  const owner = await person(url)
  await grantPlan(url, owner)
  await headAndInput(url, owner)
  await runningAndEmpty(url, owner)
}
