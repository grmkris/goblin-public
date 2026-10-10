import { mkdirSync, writeFileSync } from 'node:fs'
import { URL as FileURL } from 'node:url'
import { expect } from 'vitest'
import * as Schema from 'effect/Schema'
import { ConversationView, MoveReceipt, ThreadHeadData, TopicView } from '@goblin/contracts'
import { call, ownerFetch, person, workspaceOf, type Person } from './owner-requests.ts'

const decodeReceipt = Schema.decodeUnknownSync(MoveReceipt)
const decodeView = Schema.decodeUnknownSync(ConversationView)
const decodeHead = Schema.decodeUnknownSync(ThreadHeadData)
const decodeTopic = Schema.decodeUnknownSync(TopicView)
const Entry = Schema.Struct({
  id: Schema.Finite,
  kind: Schema.String,
  data: Schema.optional(Schema.Unknown),
  model: Schema.optional(Schema.Unknown),
  edits: Schema.optional(Schema.Unknown),
})
type Entry = typeof Entry.Type
const decodeSnapshot = Schema.decodeUnknownSync(Schema.Struct({ entries: Schema.optional(Schema.Array(Entry)) }))
const decodeRequests = Schema.decodeUnknownSync(Schema.Array(Schema.Array(Schema.String)))
const MoveRowShape = Schema.Struct({
  operationId: Schema.String,
  chatId: Schema.String,
  state: Schema.String,
  forkSession: Schema.NullOr(Schema.String),
})
const ChatShape = Schema.Struct({
  id: Schema.String,
  session: Schema.NullOr(Schema.String),
  parent: Schema.NullOr(Schema.String),
  spawner: Schema.NullOr(Schema.String),
  recallThrough: Schema.NullOr(Schema.Finite),
})
const decodeState = Schema.decodeUnknownSync(
  Schema.Struct({
    moves: Schema.Array(MoveRowShape),
    chats: Schema.Array(ChatShape),
    memory: Schema.Array(Schema.Finite),
    sessions: Schema.Finite,
  }),
)

/** Polls `read` until `done` holds, for up to ten seconds. */
async function until<A>(read: () => Promise<A>, done: (value: A) => boolean, what: string): Promise<A> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await read()
    if (done(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const send = (url: string, owner: Person, chat: string, input: string, operationId = crypto.randomUUID()) =>
  call(url, owner, `/api/conversations/${chat}/messages`, { input, operationId })
const move = (url: string, owner: Person, chat: string, entry: number, operationId: string) =>
  call(url, owner, `/api/conversations/${chat}/move`, { entry, operationId })
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
const entries = async (url: string, owner: Person, chat: string): Promise<readonly Entry[]> =>
  decodeSnapshot(await (await call(url, owner, `/api/conversations/${chat}/snapshot`)).json()).entries ?? []
const text = (entry: Entry): string => JSON.stringify(entry.model ?? null)
/** How many of `chat`'s answers say exactly `echo: <said>`. */
const echoes = async (url: string, owner: Person, chat: string, said: string) =>
  (await entries(url, owner, chat)).filter(
    (entry) => entry.kind === 'pi.assistant' && text(entry).includes(`"echo: ${said}"`),
  ).length
const waitEcho = (url: string, owner: Person, chat: string, said: string) =>
  until(
    async () => echoes(url, owner, chat, said),
    (count) => count > 0,
    `echo of ${said} in ${chat}`,
  )
/** The entry id of the owner's message `said` in `chat`. */
const messageId = async (url: string, owner: Person, chat: string, said: string): Promise<number> =>
  (
    await until(
      async () =>
        (await entries(url, owner, chat)).find(
          (entry) => entry.kind === 'pi.user' && text(entry).includes(JSON.stringify(said)),
        ),
      (entry) => entry !== undefined,
      `message ${said}`,
    )
  )?.id ?? 0
const held = async (url: string, owner: Person) => (await call(url, owner, '/__test/queue/held')).text()
const holding = (url: string, owner: Person, input: string) =>
  until(
    async () => held(url, owner),
    (inputs) => inputs.includes(input),
    `${input} held`,
  )
const release = (url: string, owner: Person, input: string) => call(url, owner, '/__test/queue/release', { input })
const requests = async (url: string, owner: Person) =>
  decodeRequests(await (await call(url, owner, '/__test/move/requests')).json())
const state = async (url: string, owner: Person) =>
  decodeState(await (await call(url, owner, '/__test/move/state')).json())
const views = async (url: string, owner: Person) => (await workspaceOf(url, owner)).conversations
const heads = async (url: string, owner: Person, chat: string) =>
  (await entries(url, owner, chat)).filter((entry) => entry.kind === 'app.thread_head').map((e) => decodeHead(e.data))

/** Waits until `chat`'s transcript holds `needle`. */
const showing = (url: string, owner: Person, chat: string, needle: string) =>
  until(
    async () => JSON.stringify(await entries(url, owner, chat)),
    (body) => body.includes(needle),
    `${needle} in ${chat}`,
  )

async function owned(url: string): Promise<Person> {
  const owner = await person(url)
  await call(url, owner, '/__test/billing/override', { userId: owner.userId, dailyCredits: 1000 })
  return owner
}

/** Sends `said` into `chat` and waits for its answer: a settled turn, when nothing else runs there. */
async function turn(url: string, owner: Person, chat: string, said: string): Promise<number> {
  expect((await send(url, owner, chat, said)).status).toBe(202)
  await waitEcho(url, owner, chat, said)
  return messageId(url, owner, chat, said)
}

/** The entries a head omits from its chat's model context. */
const omitted = (entry: Entry | undefined): readonly number[] =>
  Schema.decodeUnknownSync(
    Schema.Struct({ edits: Schema.optional(Schema.Array(Schema.Struct({ target: Schema.Finite }))) }),
  )(entry).edits?.map((edit) => edit.target) ?? []

/**
 * Settled-turn Move (ADR 0034, MF): the chat's newest finished turn moves into a new Thread forked at its end. The
 * chat's next request leaves the turn out, the Thread goes on from it, the memory forgets it, and the same operation
 * finds the same move.
 */
export async function moveSettledCase(url: string): Promise<void> {
  const owner = await owned(url)
  await turn(url, owner, '1', 'before the move')
  const moved = 'move me now'
  const entry = await turn(url, owner, '1', moved)
  const before = (await state(url, owner)).sessions
  const operationId = crypto.randomUUID()
  const receipt = decodeReceipt(await (await move(url, owner, '1', entry, operationId)).json())
  expect(receipt).toMatchObject({ operationId, chat: '1', state: 'settled' })
  const thread = receipt.thread ?? ''
  expect((await state(url, owner)).sessions).toBe(before + 1)
  const view = (await views(url, owner)).find((each) => each.id === thread)
  expect(view).toMatchObject({
    kind: 'thread',
    parent: '1',
    topic: 1,
    title: moved,
    movedFrom: { chat: '1', operationId },
  })
  const chat = await entries(url, owner, '1')
  const head = chat.find((each) => each.kind === 'app.thread_head')
  expect(decodeHead(head?.data)).toEqual({ thread, text: moved, operationId, moved: true })
  expect(text(head ?? { id: 0, kind: '' })).toContain(`[moved to thread \\"${moved}\\"]`)
  const turnIds = chat.filter((each) => each.id >= entry && each.id < (head?.id ?? 0) && each.kind.startsWith('pi.'))
  expect(omitted(head)).toEqual(turnIds.map((each) => each.id))
  // The chat's next request leaves the moved turn out; the Thread's next request goes on from it.
  await turn(url, owner, '1', 'after the move')
  await turn(url, owner, thread, 'and in the thread')
  const seen = await requests(url, owner)
  const chatRequest = seen.findLast((messages) => messages.at(-1) === 'after the move') ?? []
  expect(chatRequest).toEqual([
    'before the move',
    'echo: before the move',
    `[moved to thread "${moved}"]`,
    'after the move',
  ])
  const threadRequest = seen.findLast((messages) => messages.at(-1) === 'and in the thread') ?? []
  expect(threadRequest).toEqual(expect.arrayContaining(['before the move', moved, `echo: ${moved}`]))
  expect(threadRequest).not.toContain('after the move')
  // The chat's memory forgets the turn, also after the builder catches up on later turns.
  await until(
    async () => (await state(url, owner)).memory,
    (logged) => logged.some((id) => id > (head?.id ?? 0)),
    'memory past the move',
  )
  const memory = (await state(url, owner)).memory
  for (const id of turnIds.map((each) => each.id)) expect(memory).not.toContain(id)
  // The same operation finds the same move; the moved turn cannot move twice.
  expect(decodeReceipt(await (await move(url, owner, '1', entry, operationId)).json())).toEqual(receipt)
  const again = decodeReceipt(await (await move(url, owner, '1', entry, crypto.randomUUID())).json())
  expect(again).toMatchObject({ state: 'refused', reason: 'moved' })
  expect((await move(url, owner, thread, entry, operationId)).status).toBe(409)
  expect((await state(url, owner)).sessions).toBe(before + 1)
}

/**
 * What cannot move is refused with a reason, kept for its operation: a running turn (`streaming`), an older turn
 * (`not_latest`), an answer (`not_user_message`), a Thread (`not_conversation`). One operation repeated at once makes
 * one move; another one at the same time conflicts or finds the turn moved.
 */
export async function moveRefusedCase(url: string): Promise<void> {
  const owner = await owned(url)
  const older = await turn(url, owner, '1', 'an older turn')
  const running = 'queue-hold:still running'
  expect((await send(url, owner, '1', running)).status).toBe(202)
  await holding(url, owner, running)
  const runningEntry = await messageId(url, owner, '1', running)
  const streaming = crypto.randomUUID()
  const refused = decodeReceipt(await (await move(url, owner, '1', runningEntry, streaming)).json())
  expect(refused).toMatchObject({ state: 'refused', reason: 'streaming' })
  await release(url, owner, running)
  await waitEcho(url, owner, '1', running)
  expect(decodeReceipt(await (await move(url, owner, '1', runningEntry, streaming)).json())).toEqual(refused)
  expect(decodeReceipt(await (await move(url, owner, '1', older, crypto.randomUUID())).json())).toMatchObject({
    reason: 'not_latest',
  })
  const answer = (await entries(url, owner, '1')).findLast((each) => each.kind === 'pi.assistant')?.id ?? 0
  expect(decodeReceipt(await (await move(url, owner, '1', answer, crypto.randomUUID())).json())).toMatchObject({
    reason: 'not_user_message',
  })
  const side = decodeView(await (await call(url, owner, '/api/conversations', {})).json())
  const sideEntry = await turn(url, owner, side.id, 'in a side thread')
  expect(decodeReceipt(await (await move(url, owner, side.id, sideEntry, crypto.randomUUID())).json())).toMatchObject({
    reason: 'not_conversation',
  })
  const before = (await state(url, owner)).sessions
  const operationId = crypto.randomUUID()
  // The same operation twice at once; the other one is sent only while that move holds after its fork, so it always
  // comes second (409 while the move works, else the turn is already moved).
  expect((await call(url, owner, '/__test/move/pause', { phase: 'fork' })).status).toBe(200)
  const pair = [move(url, owner, '1', runningEntry, operationId), move(url, owner, '1', runningEntry, operationId)]
  await until(
    async () => (await (await call(url, owner, '/__test/move/paused')).text()).includes('fork'),
    Boolean,
    'the move paused after its fork',
  )
  const other = move(url, owner, '1', runningEntry, crypto.randomUUID())
  expect((await call(url, owner, '/__test/move/resume', {})).status).toBe(200)
  const [first, second, third] = await Promise.all([...pair, other])
  const [a, b] = [decodeReceipt(await first?.json()), decodeReceipt(await second?.json())]
  expect(a).toEqual(b)
  expect(a).toMatchObject({ state: 'settled' })
  if (third?.status === 200) expect(decodeReceipt(await third.json())).toMatchObject({ reason: 'moved' })
  else expect(third?.status).toBe(409)
  expect((await state(url, owner)).sessions).toBe(before + 1)
  expect(await heads(url, owner, '1')).toHaveLength(1)
  // With the newest turn moved, the one before it is the newest the chat still shows: it moves too.
  const earlier = decodeReceipt(await (await move(url, owner, '1', older, crypto.randomUUID())).json())
  expect(earlier).toMatchObject({ state: 'settled' })
  expect(await heads(url, owner, '1')).toHaveLength(2)
  // That Thread holds the earlier turn only, never the one moved before it.
  const earlierThread = JSON.stringify(await entries(url, owner, earlier.thread ?? ''))
  expect(earlierThread).toContain('echo: an older turn')
  expect(earlierThread).not.toContain(running)
}

/**
 * A restart after the fork or after the head finishes the move once: one Thread, one head, the turn omitted. The test
 * agent stops the object at that boundary and holds the mover there, so the first request can only end in the reset.
 * What the restarted object holds before the repeat is not asserted: its start finishes the move by itself
 * (`reconcile`), so the invariants are checked after the repeat instead.
 */
export async function moveRestartCase(url: string): Promise<void> {
  const owner = await owned(url)
  await turn(url, owner, '1', 'restart history')
  for (const phase of ['fork', 'head'] as const) {
    const moved = `restart at ${phase}`
    const entry = await turn(url, owner, '1', moved)
    const before = (await state(url, owner)).sessions
    expect((await call(url, owner, '/__test/move/crash', { phase })).status).toBe(200)
    const operationId = crypto.randomUUID()
    // expected: the object stops at the boundary, so the request may fail before it answers.
    const crashed = await move(url, owner, '1', entry, operationId).catch(() => undefined)
    expect(crashed?.status ?? 500).toBeGreaterThanOrEqual(500)
    const receipt = await until(
      async () => {
        // expected: the object may still be restarting; the next read tries again.
        const response = await move(url, owner, '1', entry, operationId).catch(() => undefined)
        return response?.status === 200 ? decodeReceipt(await response.json()) : undefined
      },
      (value) => value?.state === 'settled',
      `move settled after a restart at ${phase}`,
    )
    const thread = receipt?.thread ?? ''
    const after = await state(url, owner)
    expect(after.sessions).toBe(before + 1)
    expect(after.moves.filter((row) => row.operationId === operationId)).toEqual([
      expect.objectContaining({ state: 'settled', forkSession: thread }),
    ])
    expect(after.chats.filter((chat) => chat.session === thread)).toHaveLength(1)
    expect((await heads(url, owner, '1')).filter((head) => head.operationId === operationId)).toEqual([
      { thread, text: moved, operationId, moved: true },
    ])
    expect(JSON.stringify(await entries(url, owner, thread))).toContain(`echo: ${moved}`)
    await turn(url, owner, '1', `after ${phase}`)
    const seen = await requests(url, owner)
    const request = seen.findLast((messages) => messages.at(-1) === `after ${phase}`) ?? []
    expect(request).not.toContain(moved)
    expect(request).not.toContain(`echo: ${moved}`)
    expect(request).toContain(`[moved to thread "${moved}"]`)
  }
}

/**
 * Stop and Close around a move: a Stop of the chat while the move waits after its fork leaves the move to finish; the
 * moved Thread is an ordinary thread, whose Close stops its own run and leaves the chat answering.
 */
export async function moveStopCase(url: string): Promise<void> {
  const owner = await owned(url)
  await turn(url, owner, '1', 'stop history')
  const entry = await turn(url, owner, '1', 'stop around the move')
  expect((await call(url, owner, '/__test/move/pause', { phase: 'fork' })).status).toBe(200)
  const paused = move(url, owner, '1', entry, crypto.randomUUID())
  await until(
    async () => (await (await call(url, owner, '/__test/move/paused')).text()).includes('fork'),
    Boolean,
    'paused after the fork',
  )
  expect((await call(url, owner, '/api/conversations/1/stop', {})).status).toBe(200)
  expect((await call(url, owner, '/__test/move/resume', {})).status).toBe(200)
  const receipt = decodeReceipt(await (await paused).json())
  expect(receipt).toMatchObject({ state: 'settled' })
  const thread = receipt.thread ?? ''
  const hold = 'queue-hold:in the moved thread'
  expect((await send(url, owner, thread, hold)).status).toBe(202)
  await holding(url, owner, hold)
  expect((await call(url, owner, '/api/conversations/1/stop', {})).status).toBe(200)
  expect(await held(url, owner)).toContain(hold)
  expect((await patch(url, owner, `/api/conversations/${thread}`, { closed: true })).status).toBe(200)
  await until(
    async () => held(url, owner),
    (inputs) => !inputs.includes(hold),
    'closed thread stopped',
  )
  await turn(url, owner, '1', 'still answering')
}

/**
 * Helpers and memory: a helper the chat started before the moved turn still reports to the chat, one the moved turn
 * started reports to the Thread (its relay handed over), and the Thread zooms into the chat's memory only up to the
 * moved message.
 */
export async function moveHelpersCase(url: string): Promise<void> {
  const owner = await owned(url)
  expect(
    (await send(url, owner, '1', 'call subagent_spawn {"name":"pre","message":"queue-hold:pre-job"}')).status,
  ).toBe(202)
  await holding(url, owner, 'queue-hold:pre-job')
  await showing(url, owner, '1', 'done: Started pre')
  const spawning = 'call subagent_spawn {"name":"post","message":"queue-hold:post-job"}'
  expect((await send(url, owner, '1', spawning)).status).toBe(202)
  await holding(url, owner, 'queue-hold:post-job')
  await showing(url, owner, '1', 'done: Started post')
  const entry = await messageId(url, owner, '1', spawning)
  const receipt = await until(
    async () => decodeReceipt(await (await move(url, owner, '1', entry, crypto.randomUUID())).json()),
    (value) => value.state === 'settled',
    'the spawning turn settled and moved',
  )
  const thread = receipt.thread ?? ''
  const after = await state(url, owner)
  const post = after.chats.find((chat) => chat.parent === thread)
  expect(post?.spawner).toBe(thread)
  const recall = after.chats.find((chat) => chat.id === thread)?.recallThrough
  expect(after.memory.every((logged) => logged < entry)).toBe(true)
  expect(recall).toBe(after.memory.length)
  await release(url, owner, 'queue-hold:post-job')
  await showing(url, owner, thread, '[from subagent post]')
  await release(url, owner, 'queue-hold:pre-job')
  await showing(url, owner, '1', '[from subagent pre]')
  expect(JSON.stringify(await entries(url, owner, '1'))).not.toContain('[from subagent post]')
  expect((await send(url, owner, thread, `call zoom {"id":${recall ?? 0},"n":1}`)).status).toBe(202)
  await showing(url, owner, thread, `No line ${recall ?? 0}+1`)
}

/** A turn waiting on the owner's approval of an MCP call stays in its chat (`awaiting_approval`): it resumes there. */
export async function moveApprovalCase(url: string): Promise<void> {
  const owner = await owned(url)
  const server = 'apps-fixture'
  expect((await call(url, owner, `/api/mcp/${server}/connect`, {})).status).toBe(200)
  const put = (path: string, body: unknown) =>
    ownerFetch(`${url}${path}`, {
      method: 'PUT',
      headers: {
        cookie: owner.cookie,
        origin: 'https://goblin.test',
        'content-type': 'application/json',
        'x-goblin-csrf': '1',
      },
      body: JSON.stringify(body),
    })
  expect((await put('/api/mcp/grants', { serverId: server, name: 'board', allowed: true })).status).toBe(200)
  expect((await put('/api/mcp/ask-first', { serverId: server, name: 'board', enabled: true })).status).toBe(200)
  await turn(url, owner, '1', 'approval history')
  const args = { serverId: server, name: 'board', arguments: { operationKey: 'moved-approval' } }
  const asking = `call mcp_call ${JSON.stringify(args)}`
  expect((await send(url, owner, '1', asking)).status).toBe(202)
  await showing(url, owner, '1', 'approval-required')
  const entry = await messageId(url, owner, '1', asking)
  const receipt = await until(
    async () => decodeReceipt(await (await move(url, owner, '1', entry, crypto.randomUUID())).json()),
    (value) => value.reason !== 'streaming',
    'the asking turn settled',
  )
  expect(receipt).toMatchObject({ state: 'refused', reason: 'awaiting_approval' })
}

/** The time `rounds` reads of a chat's newest entries and model context take, best of three, in milliseconds. */
async function readCost(url: string, owner: Person, chat: string): Promise<number> {
  const once = async () => {
    const started = performance.now()
    expect((await call(url, owner, '/__test/move/latency', { chat, rounds: 200 })).status).toBe(200)
    return performance.now() - started
  }
  await once()
  return Math.min(await once(), await once(), await once())
}

/** A Topic with three exchanges, ready for moves or thread heads. */
async function talkedTopic(url: string, owner: Person, name: string): Promise<TopicView> {
  const topic = decodeTopic(
    await (await call(url, owner, '/api/topics', { name, operationId: crypto.randomUUID() })).json(),
  )
  for (const said of [`${name} one`, `${name} two`, `${name} three`]) {
    expect((await send(url, owner, topic.conversation, said)).status).toBe(202)
    await waitEcho(url, owner, topic.conversation, said)
  }
  return topic
}

/**
 * A Topic's Conversation moves like Personal's. Then the latency kill criterion: after 20 more moves chained on that
 * chat, its reads cost at most twice those of a control chat with the same turns that never moved. A settled move
 * forks the Thread, never the chat, so the chat's session does not deepen. Logs the timings for the record.
 */
export async function moveTopicCase(url: string): Promise<void> {
  const owner = await owned(url)
  const topic = await talkedTopic(url, owner, 'Moves')
  const channel = topic.conversation
  const entry = await turn(url, owner, channel, 'topic move')
  const receipt = decodeReceipt(await (await move(url, owner, channel, entry, crypto.randomUUID())).json())
  expect(receipt).toMatchObject({ state: 'settled', chat: channel })
  expect((await views(url, owner)).find((view) => view.id === receipt.thread)).toMatchObject({
    topic: topic.id,
    parent: channel,
  })
  expect(await heads(url, owner, channel)).toHaveLength(1)
  expect(JSON.stringify(await entries(url, owner, '1'))).not.toContain('topic move')
  const before = await readCost(url, owner, channel)
  const control = await talkedTopic(url, owner, 'Control')
  for (let index = 0; index < 20; index++) {
    const said = `chained ${index}`
    const chained = await turn(url, owner, channel, said)
    const each = decodeReceipt(await (await move(url, owner, channel, chained, crypto.randomUUID())).json())
    expect(each).toMatchObject({ state: 'settled' })
    await turn(url, owner, control.conversation, said)
  }
  expect(await heads(url, owner, channel)).toHaveLength(21)
  const chained = await readCost(url, owner, channel)
  const same = await readCost(url, owner, control.conversation)
  // The timings, for the record (ADR 0034): milliseconds for 200 rounds of entries(50) and context().
  const path = new FileURL('../../.alchemy/goblin-move-latency.json', import.meta.url)
  mkdirSync(new FileURL('./', path), { recursive: true })
  writeFileSync(path, JSON.stringify({ environment: 'local-workerd', before, chained, control: same }, null, 2))
  expect(chained).toBeLessThanOrEqual(2 * same)
}
