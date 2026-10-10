import { expect } from 'vitest'
import * as Schema from 'effect/Schema'
import { SourcesDetails, type TopicView } from '@goblin/contracts'
import { type AgentFetch, callOwner } from '../owner-client.ts'
import { grantPlan, lever, person, showing, signedIn, type Person } from './owner-requests.ts'
import { answerOf, ownerSnapshot } from './probe-reads.ts'
import { waitFor } from './until.ts'

const decodeExcerpts = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({ entry: Schema.Number, session: Schema.String, chat: Schema.String, text: Schema.String }),
  ),
)
const decodeSeen = Schema.decodeUnknownSync(
  Schema.Struct({
    requests: Schema.Array(
      Schema.Struct({
        messages: Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String })),
        context: Schema.optional(Schema.String),
      }),
    ),
  }),
)
const decodeEntries = Schema.decodeUnknownSync(
  Schema.Struct({ entries: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.Number, kind: Schema.String }))) }),
)

/** Sends `input` to `chat` and waits for the scripted model's echo of it. */
async function say(me: AgentFetch, chat: string, input: string, reply = `echo: ${input}`): Promise<void> {
  const sent = await callOwner(me, (api) =>
    api.conversations.submit({ params: { id: chat }, payload: { input, operationId: crypto.randomUUID() } }),
  )
  expect(sent.accepted).toBe(true)
  await showing(me, chat, reply)
}

const topic = (me: AgentFetch, name: string): Promise<TopicView> =>
  callOwner(me, (api) => api.topics.create({ payload: { name, operationId: crypto.randomUUID() } }))

const uses = (me: AgentFetch, chat: string) =>
  callOwner(me, (api) => api.conversations.sources({ params: { id: chat } }))

/** Garden holds the answer; Old (archived later) and Quiet (opted out later) hold words only they have. */
async function seed(me: AgentFetch) {
  const garden = await topic(me, 'Garden')
  const old = await topic(me, 'Old')
  const quiet = await topic(me, 'Quiet')
  await say(me, garden.conversation, 'we chose heirloom tomatoes for the raised beds')
  await say(me, garden.conversation, 'the seed shop login is api_key=fixture-not-a-secret')
  await say(me, old.conversation, 'the greenhouse budget was 400 euros')
  await say(me, quiet.conversation, 'quiet marigold notes')
  await callOwner(me, (api) => api.topics.update({ params: { id: old.id }, payload: { archived: true } }))
  await callOwner(me, (api) => api.topics.update({ params: { id: quiet.id }, payload: { searchExcluded: true } }))
  const snapshot = decodeEntries(await ownerSnapshot(me, garden.conversation))
  const entry = (snapshot.entries ?? []).findLast(({ kind }) => kind === 'pi.assistant')?.id
  if (entry === undefined) throw new Error('no answer in the Garden')
  const branched = await callOwner(me, (api) =>
    api.conversations.create({ payload: { from: { conversation: garden.conversation, entry } } }),
  )
  await say(me, branched.id, 'compost from the farm')
  return { garden, old, quiet, thread: branched.id }
}

/** Until the sources of main's answers hold `needle`. */
const sourced = (me: AgentFetch, needle: string) =>
  waitFor(
    async () => JSON.stringify(await uses(me, '1')),
    (text) => text.includes(needle),
    `${needle} among the sources`,
  )

/** `search_chats` from Personal: default Topics only, a named one whatever its state, every result recorded. */
async function searches(me: AgentFetch, garden: TopicView): Promise<void> {
  await say(me, '1', 'call search_chats {"query":"heirloom tomatoes"}', 'done: Quoted history')
  const [found] = await uses(me, '1')
  expect(found).toMatchObject({ mode: 'tool', chat: '1' })
  const details = Schema.decodeUnknownSync(SourcesDetails)({ kind: 'sources', mode: 'tool', sources: found?.sources })
  expect(details.sources[0]).toMatchObject({ topic: garden.id, topicName: 'Garden', chat: garden.conversation })
  expect(details.sources[0]?.excerpt).toContain('heirloom tomatoes')
  await say(me, '1', 'call search_chats {"query":"greenhouse marigold"}', 'done: No earlier messages matched')
  await say(me, '1', 'call search_chats {"query":"greenhouse budget","topic":"Old"}', 'done: Quoted history')
  await sourced(me, '"topicName":"Old"')
  await say(me, '1', 'call search_chats {"query":"marigold","topic":"quiet"}', 'done: Quoted history')
  await sourced(me, '"topicName":"Quiet"')
  const named = (await uses(me, '1')).slice(0, 2).map((use) => use.sources.map((source) => source.topicName))
  expect(named).toEqual([['Quiet'], ['Old']])
}

/** The context block of the newest model request that answered `input` (the scripted model records each request). */
async function contextOf(url: string, owner: Person, input: string): Promise<string> {
  const { requests } = decodeSeen(await (await lever(url, owner, 'queue/seen')).json())
  const request = requests.findLast(
    (seen) => seen.messages.findLast((message) => message.role === 'user')?.text === input,
  )
  expect(request).toBeDefined()
  return request?.context ?? ''
}

/** The first request after an input carries the sources the rerank picked; an abstention adds nothing. */
async function automatic(url: string, owner: Person, garden: TopicView): Promise<void> {
  const me = signedIn(url, owner)
  const picked = 'pick-sources what did we decide about heirloom tomatoes'
  await say(me, '1', picked)
  const context = await contextOf(url, owner, picked)
  expect(context).toContain('<sources>')
  expect(context).toContain('heirloom tomatoes for the raised beds')
  expect(context).toContain('Quoted history')
  const [auto] = await uses(me, '1')
  expect(auto).toMatchObject({ mode: 'auto', inputEntry: expect.any(Number) })
  expect(auto?.sources.map((source) => source.chat)).toEqual([garden.conversation])
  const before = (await uses(me, '1')).length
  const declined = 'and what about heirloom tomatoes next year'
  await say(me, '1', declined)
  expect(await contextOf(url, owner, declined)).not.toContain('<sources>')
  expect(await uses(me, '1')).toHaveLength(before)
}

export async function retrievalCase(url: string): Promise<void> {
  const owner = await person(url)
  const other = await person(url)
  for (const who of [owner, other]) await grantPlan(url, who)
  const me = signedIn(url, owner)
  const { garden, thread } = await seed(me)
  await searches(me, garden)
  await automatic(url, owner, garden)
  // The index holds each entry once, under the chat that wrote it, and never a credential-shaped value.
  const excerpts = decodeExcerpts(await (await lever(url, owner, 'retrieval/excerpts')).json())
  const said = 'we chose heirloom tomatoes for the raised beds'
  const heirloom = excerpts.filter((row) => row.text === said || row.text === `echo: ${said}`)
  expect(heirloom.map((row) => row.chat)).toEqual([garden.conversation, garden.conversation])
  expect(excerpts.filter((row) => row.chat === thread).map((row) => row.text)).toEqual([
    'compost from the farm',
    'echo: compost from the farm',
  ])
  expect(JSON.stringify(excerpts)).not.toContain('fixture-not-a-secret')
  expect(JSON.stringify(excerpts)).toContain('api_key=[redacted]')
  // Another account has its own, empty, record and cannot read the owner's chats.
  const them = signedIn(url, other)
  expect(await uses(them, '1')).toEqual([])
  expect(await answerOf(them, (api) => api.conversations.sources({ params: { id: garden.conversation } }))).toBe(
    'NotFound',
  )
}
