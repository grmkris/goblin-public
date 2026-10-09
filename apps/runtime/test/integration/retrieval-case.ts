import { expect } from 'vitest'
import * as Schema from 'effect/Schema'
import { ConversationView, SourceUse, SourcesDetails, TopicView } from '@goblin/contracts'
import { call, ownerFetch, person, waitFor, type Person } from './owner-requests.ts'

const decodeTopic = Schema.decodeUnknownSync(TopicView)
const decodeView = Schema.decodeUnknownSync(ConversationView)
const decodeUses = Schema.decodeUnknownSync(Schema.Array(SourceUse))
const decodeExcerpts = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({ entry: Schema.Number, session: Schema.String, chat: Schema.String, text: Schema.String }),
  ),
)
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

/** Sends `input` to `chat` and waits for the scripted model's echo of it. */
async function say(url: string, owner: Person, chat: string, input: string, reply = `echo: ${input}`): Promise<void> {
  const sent = await call(url, owner, `/api/conversations/${chat}/messages`, {
    input,
    operationId: crypto.randomUUID(),
  })
  expect(sent.status).toBe(202)
  await waitFor(url, owner, `/api/conversations/${chat}/snapshot`, reply)
}

async function topic(url: string, owner: Person, name: string): Promise<TopicView> {
  const created = await call(url, owner, '/api/topics', { name, operationId: crypto.randomUUID() })
  expect(created.status).toBe(201)
  return decodeTopic(await created.json())
}

const uses = async (url: string, owner: Person, chat: string) =>
  decodeUses(await (await call(url, owner, `/api/conversations/${chat}/sources`)).json())

/** Garden holds the answer; Old (archived later) and Quiet (opted out later) hold words only they have. */
async function seed(url: string, owner: Person) {
  const garden = await topic(url, owner, 'Garden')
  const old = await topic(url, owner, 'Old')
  const quiet = await topic(url, owner, 'Quiet')
  await say(url, owner, garden.conversation, 'we chose heirloom tomatoes for the raised beds')
  await say(url, owner, garden.conversation, 'the seed shop login is api_key=fixture-not-a-secret')
  await say(url, owner, old.conversation, 'the greenhouse budget was 400 euros')
  await say(url, owner, quiet.conversation, 'quiet marigold notes')
  expect((await patch(url, owner, `/api/topics/${old.id}`, { archived: true })).status).toBe(200)
  expect((await patch(url, owner, `/api/topics/${quiet.id}`, { searchExcluded: true })).status).toBe(200)
  const snapshot = decodeEntries(
    await (await call(url, owner, `/api/conversations/${garden.conversation}/snapshot`)).json(),
  )
  const entry = (snapshot.entries ?? []).findLast(({ kind }) => kind === 'pi.assistant')?.id
  const branched = await call(url, owner, '/api/conversations', { from: { conversation: garden.conversation, entry } })
  const thread = decodeView(await branched.json()).id
  await say(url, owner, thread, 'compost from the farm')
  return { garden, old, quiet, thread }
}

/** `search_chats` from Personal: default Topics only, a named one whatever its state, every result recorded. */
async function searches(url: string, owner: Person, garden: TopicView): Promise<void> {
  await say(url, owner, '1', 'call search_chats {"query":"heirloom tomatoes"}', 'done: Quoted history')
  const [found] = await uses(url, owner, '1')
  expect(found).toMatchObject({ mode: 'tool', chat: '1' })
  const details = Schema.decodeUnknownSync(SourcesDetails)({ kind: 'sources', mode: 'tool', sources: found?.sources })
  expect(details.sources[0]).toMatchObject({ topic: garden.id, topicName: 'Garden', chat: garden.conversation })
  expect(details.sources[0]?.excerpt).toContain('heirloom tomatoes')
  await say(url, owner, '1', 'call search_chats {"query":"greenhouse marigold"}', 'done: No earlier messages matched')
  await say(url, owner, '1', 'call search_chats {"query":"greenhouse budget","topic":"Old"}', 'done: Quoted history')
  await waitFor(url, owner, '/api/conversations/1/sources', '"topicName":"Old"')
  await say(url, owner, '1', 'call search_chats {"query":"marigold","topic":"quiet"}', 'done: Quoted history')
  await waitFor(url, owner, '/api/conversations/1/sources', '"topicName":"Quiet"')
  const named = (await uses(url, owner, '1')).slice(0, 2).map((use) => use.sources.map((source) => source.topicName))
  expect(named).toEqual([['Quiet'], ['Old']])
}

export async function retrievalCase(url: string): Promise<void> {
  const owner = await person(url)
  const other = await person(url)
  for (const who of [owner, other])
    await call(url, who, '/__test/billing/override', { userId: who.userId, dailyCredits: 1000 })
  const { garden, thread } = await seed(url, owner)
  await searches(url, owner, garden)
  // The index holds each entry once, under the chat that wrote it, and never a credential-shaped value.
  const excerpts = decodeExcerpts(await (await call(url, owner, '/__test/retrieval/excerpts')).json())
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
  expect(await uses(url, other, '1')).toEqual([])
  expect((await call(url, other, `/api/conversations/${garden.conversation}/sources`)).status).toBe(404)
}
