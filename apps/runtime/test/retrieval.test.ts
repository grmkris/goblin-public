import type { Message } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { SourcesDetails } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Schema from 'effect/Schema'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { KeyedLock } from '../src/observability/lock.ts'
import { TranscriptIndex, type TranscriptSource } from '../src/retrieval/index.ts'
import { AUTO_THRESHOLD, chooseSources, gateFor, parseSelection } from '../src/retrieval/auto.ts'
import { ChatRetrieval, autoUseId, catchUpChats, catchUpSession, retrievalOver } from '../src/retrieval/service.ts'
import { EXCERPT_CHARS, excerptOf, ftsQuery, mergeRanges, sourcesText } from '../src/retrieval/text.ts'
import { conversationId, entryId } from '../src/pi/context.ts'
import { chatDatabase } from './chats-sqlite.ts'

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/** A Pi entry as the index reads it: a user input, or an assistant answer with one text block. */
function entry(
  id: number,
  session: number,
  kind: 'pi.user' | 'pi.assistant' | 'app.persona_ask',
  text: string,
): EntryRecord {
  const timestamp = 1_700_000_000_000 + id
  const message: Message =
    kind === 'pi.assistant'
      ? {
          role: 'assistant',
          api: 'openai-completions',
          provider: 'fixture',
          model: 'fixture',
          content: [{ type: 'text', text }],
          usage,
          stopReason: 'stop',
          timestamp,
        }
      : { role: 'user', content: text, timestamp }
  return { id: entryId(id), conversationId: conversationId(String(session)), kind, model: [message] }
}

/** Pi as the index reads it: each session's fork-aware history (inherited entries carry their own session). */
function piSource(histories: Readonly<Record<string, readonly EntryRecord[]>>): TranscriptSource & { reads: number } {
  const history = (session: string) => (histories[session] ?? []).toSorted((a, b) => b.id - a.id)
  const fake = {
    reads: 0,
    newest: async (session: string) => history(session)[0]?.id,
    entries: async (session: string, from: number, to: number) => {
      fake.reads += 1
      return history(session).filter((each) => each.id >= from && each.id <= to)
    },
    recent: async (session: string, limit: number) => history(session).slice(0, limit),
  }
  return fake
}

const open: (() => void)[] = []
afterEach(() => {
  for (const close of open.splice(0)) close()
})

/** The agent's per-key lock, as the Retrieval service takes it: catch-ups of one session run one at a time. */
const locks = ManagedRuntime.make(KeyedLock.layer)
const lock = await locks.runPromise(KeyedLock.useSync((service) => service))
afterAll(() => locks.dispose())
/** One session's catch-up under its turn of the lock. */
const indexOne = (index: TranscriptIndex, session: string, maxEntries?: number) =>
  Effect.runPromise(catchUpSession(index, lock, session, maxEntries))
/** The bounded catch-up of every chat a search makes first. */
const indexAll = (index: TranscriptIndex) => Effect.runPromise(catchUpChats(index, lock))
/** The Retrieval service over `retrieval`, its calls run to their value. */
const serviceOf = (retrieval: ChatRetrieval) => retrievalOver(retrieval, lock)

/** Topics: Personal (1), Garden (2), Old (3, archived), Quiet (4, opted out of search); their chats and a persona fork. */
function fixture() {
  const database = chatDatabase()
  open.push(database.close)
  const { sqlite } = database
  sqlite.exec(`INSERT INTO app_topics (id, name, chat_id, archived_at, search_excluded, created_by, created_at, updated_at) VALUES
    (2, 'Garden', '10', NULL, 0, 'owner', 1, 1), (3, 'Old', '20', 5, 0, 'owner', 1, 1), (4, 'Quiet', '30', NULL, 1, 'owner', 1, 1)`)
  sqlite.exec(`INSERT INTO app_conversations (session_id, pi_session, role, kind, title, parent_session, created_at, topic_id) VALUES
    ('1', '1', 'primary', 'main', NULL, NULL, 1, 1),
    ('10', '10', 'conversation', 'main', 'Garden', NULL, 1, 2),
    ('13', '13', NULL, 'thread', 'Compost', '10', 1, 2),
    ('20', '20', 'conversation', 'main', 'Old', NULL, 1, 3),
    ('30', '30', 'conversation', 'main', 'Quiet', NULL, 1, 4),
    ('40', '40', 'persona', 'thread', NULL, '10', 1, 2),
    ('50', '50', NULL, 'thread', 'Keys', '1', 1, 1)`)
  const garden = [
    entry(11, 10, 'pi.user', 'We plan tomatoes and basil in raised beds'),
    entry(12, 10, 'pi.assistant', 'Raised beds need 30 cm of soil'),
  ]
  const pi = piSource({
    '1': [
      entry(2, 1, 'pi.user', 'Japan trip budget'),
      entry(3, 1, 'pi.assistant', 'About 3000 euros'),
      entry(4, 1, 'app.persona_ask', 'Critic, is 3000 euros enough?'),
    ],
    '10': garden,
    '13': [
      ...garden,
      entry(14, 13, 'pi.user', 'Order compost for the tomatoes'),
      entry(15, 13, 'pi.assistant', 'Compost ordered'),
    ],
    '20': [entry(21, 20, 'pi.user', 'The old tomatoes greenhouse plan')],
    '30': [entry(31, 30, 'pi.user', 'tomatoes in the quiet topic')],
    '40': [...garden, entry(41, 40, 'pi.user', 'tomatoes from a persona fork')],
    '50': [entry(51, 50, 'pi.user', 'the tomatoes shop login is api_key=hunter2-not-real and Bearer abc.def.ghi')],
  })
  let now = 1_000
  const index = new TranscriptIndex(database.db, pi, () => now)
  return { ...database, pi, index, tick: () => (now += 1) }
}

const Excerpts = Schema.Array(Schema.Struct({ entry: Schema.Number, chat: Schema.String, text: Schema.String }))
const excerpts = (sqlite: ReturnType<typeof chatDatabase>['sqlite']) =>
  Schema.decodeUnknownSync(Excerpts)(
    sqlite
      .prepare('SELECT entry_id AS entry, chat_id AS chat, text FROM app_transcript_excerpts ORDER BY entry_id')
      .all(),
  )

describe('transcript index', () => {
  it('indexes only the entries each session owns, never a persona fork, and catches up from where it stopped', async () => {
    const { sqlite, index, pi } = fixture()
    // The thread first: its inherited Garden entries must still be left to Garden's own session.
    expect(await indexOne(index, '13')).toMatchObject({ more: false })
    await indexAll(index)
    expect(excerpts(sqlite).map((row) => [row.entry, row.chat])).toEqual([
      [2, '1'],
      [3, '1'],
      [4, '1'],
      [11, '10'],
      [12, '10'],
      [14, '13'],
      [15, '13'],
      [21, '20'],
      [31, '30'],
      [51, '50'],
    ])
    const reads = pi.reads
    await indexAll(index)
    expect(pi.reads).toBe(reads)
  })

  it('reads a long history in windows and reports more until it is caught up', async () => {
    const database = chatDatabase()
    open.push(database.close)
    database.sqlite.exec(
      "INSERT INTO app_conversations (session_id, pi_session, role, kind, created_at, topic_id) VALUES ('1', '1', 'primary', 'main', 1, 1)",
    )
    const pi = piSource({ '1': [entry(2, 1, 'pi.user', 'first'), entry(1_400, 1, 'pi.user', 'far later')] })
    const index = new TranscriptIndex(database.db, pi, () => 1)
    expect(await indexOne(index, '1', 1)).toMatchObject({ more: true })
    expect(await indexOne(index, '1')).toMatchObject({ more: false })
    expect(excerpts(database.sqlite).map((row) => row.entry)).toEqual([2, 1_400])
  })

  it('catches up one session at a time, and a catch-up that failed lets the next one run', async () => {
    const database = chatDatabase()
    open.push(database.close)
    database.sqlite.exec(
      "INSERT INTO app_conversations (session_id, pi_session, role, kind, created_at, topic_id) VALUES ('1', '1', 'primary', 'main', 1, 1)",
    )
    const pi = piSource({ '1': [entry(2, 1, 'pi.user', 'first'), entry(3, 1, 'pi.assistant', 'second')] })
    let inside = 0
    let overlapped = false
    let failures = 1
    const source: TranscriptSource = {
      ...pi,
      newest: async (session) => {
        inside += 1
        overlapped ||= inside > 1
        await Promise.resolve()
        inside -= 1
        if (failures-- > 0) throw new Error('Pi is not answering')
        return pi.newest(session)
      },
    }
    const index = new TranscriptIndex(database.db, source, () => 1)
    const [first, second] = await Promise.allSettled([indexOne(index, '1'), indexOne(index, '1')])
    expect(first.status).toBe('rejected')
    expect(second).toEqual({ status: 'fulfilled', value: { more: false, read: 2 } })
    expect(overlapped).toBe(false)
    expect(excerpts(database.sqlite).map((row) => row.entry)).toEqual([2, 3])
  })

  it('scrubs credential-shaped values before they are stored or shown', async () => {
    const { sqlite, index } = fixture()
    await indexAll(index)
    const [stored] = excerpts(sqlite).filter((row) => row.entry === 51)
    expect(stored?.text).not.toContain('hunter2')
    expect(stored?.text).not.toContain('abc.def.ghi')
    expect(stored?.text).toContain('api_key=[redacted]')
    const sources = index.search('tomatoes shop login', { limit: 5 })
    expect(JSON.stringify(sources)).not.toContain('hunter2')
  })

  it('searches active Topics that take part, unless a Topic is named, and never the asking chat', async () => {
    const { index } = fixture()
    await indexAll(index)
    const chats = (topic?: number, exclude?: string) =>
      index
        .search('tomatoes', {
          limit: 5,
          ...(topic === undefined ? {} : { topic }),
          ...(exclude === undefined ? {} : { exclude }),
        })
        .map((found) => found.chat)
        .toSorted()
    expect(chats()).toEqual(['10', '13', '50'])
    expect(chats(undefined, '13')).toEqual(['10', '50'])
    expect(chats(3)).toEqual(['20'])
    expect(chats(4)).toEqual(['30'])
    expect(index.topicNamed('old')).toBe(3)
    expect(index.topicNamed('#Quiet')).toBe(4)
    expect(index.topicNamed('2')).toBe(2)
    expect(index.topicNamed('missing')).toBeUndefined()
  })

  it('returns sources in the frozen contract shape, grouped by chat and bounded', async () => {
    const { index } = fixture()
    await indexAll(index)
    const sources = index.search('raised beds tomatoes "OR" NEAR(*)', { limit: 5 })
    const details = Schema.decodeUnknownSync(SourcesDetails)({ kind: 'sources', mode: 'tool', sources })
    const garden = details.sources.find((found) => found.chat === '10')
    expect(garden).toMatchObject({ topic: 2, topicName: 'Garden', chatTitle: 'Garden', entryStart: 11, entryEnd: 12 })
    expect(garden?.excerpt).toContain('user: We plan tomatoes')
    expect(garden?.score).toBeLessThan(0)
    expect(index.search('', { limit: 5 })).toEqual([])
    expect(sourcesText(details.sources)).toMatch(/^Quoted history/u)
  })

  it('records a use once, so a replay returns the first frozen sources, and lists a chat newest first', async () => {
    const { index } = fixture()
    await indexAll(index)
    const sources = index.search('tomatoes', { limit: 1 })
    const first = index.record({ id: 'tool:1:a', chat: '1', session: '1', mode: 'tool', sources, retrievedAt: 5 })
    const again = index.record({ id: 'tool:1:a', chat: '1', session: '1', mode: 'tool', sources: [], retrievedAt: 6 })
    expect(again).toEqual(first)
    index.record({ id: 'auto:1:2', chat: '1', session: '1', inputEntry: 2, mode: 'auto', sources, retrievedAt: 7 })
    expect(index.uses('1').map((use) => [use.id, use.inputEntry])).toEqual([
      ['auto:1:2', 2],
      ['tool:1:a', undefined],
    ])
    expect(index.uses('10')).toEqual([])
  })

  it('reassigns a moved stretch of a session to its new chat', async () => {
    const { sqlite, index } = fixture()
    await indexAll(index)
    index.reassign('13', 15, '50')
    expect(
      excerpts(sqlite)
        .filter((row) => row.entry >= 14 && row.entry <= 15)
        .map((row) => row.chat),
    ).toEqual(['13', '50'])
  })
})

describe('retrieval helpers', () => {
  it('turns any text into literal FTS terms joined with OR', () => {
    expect(ftsQuery('tomatoes AND "basil" NEAR(x) col:val -neg *')).toBe(
      '"tomatoes" OR "AND" OR "basil" OR "NEAR" OR "x" OR "col" OR "val" OR "neg"',
    )
    expect(ftsQuery('Größe Ärger 東京')).toBe('"Größe" OR "Ärger" OR "東京"')
    expect(ftsQuery('!!! ...')).toBe('')
    expect(ftsQuery(Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ')).split(' OR ')).toHaveLength(32)
  })

  it('merges overlapping ranges per chat, keeps the best score and the best first', () => {
    expect(
      mergeRanges(
        [
          { chat: '2', start: 10, end: 14, score: -3 },
          { chat: '2', start: 13, end: 17, score: -5 },
          { chat: '2', start: 30, end: 34, score: -1 },
          { chat: '3', start: 12, end: 16, score: -4 },
        ],
        2,
      ),
    ).toEqual([
      { chat: '2', start: 10, end: 17, score: -5 },
      { chat: '3', start: 12, end: 16, score: -4 },
    ])
  })

  it('bounds an excerpt and gives the matching entries most of it', () => {
    const rows = [1, 2, 3].map((id) => ({
      entryId: id,
      role: 'user',
      author: id === 2 ? 'Telegram' : null,
      text: `${id} `.repeat(900),
    }))
    const text = excerptOf(rows, new Set([2]))
    expect(text.length).toBeLessThanOrEqual(EXCERPT_CHARS)
    expect(text).toContain('user (Telegram): 2 2')
  })
  it('accepts only an exact, consistent selection of offered ids', () => {
    const allowed = new Set([1, 2, 3])
    expect(parseSelection('{"ids":[2,1],"none":false}', allowed)).toEqual([2, 1])
    expect(parseSelection('```json\n{"ids":[],"none":true}\n```', allowed)).toEqual([])
    for (const bad of [
      '{"ids":[4],"none":false}',
      '{"ids":[1,1],"none":false}',
      '{"ids":[1],"none":true}',
      '{"ids":[],"none":false}',
      'no',
      '{"ids":["1"],"none":false}',
    ])
      expect(parseSelection(bad, allowed)).toBeUndefined()
  })
  it('scales the bm25 gate with the index size', () => {
    expect(gateFor(3000)).toBeCloseTo(AUTO_THRESHOLD)
    expect(gateFor(1_000_000)).toBe(AUTO_THRESHOLD)
    expect(gateFor(20)).toBeGreaterThan(AUTO_THRESHOLD)
    expect(gateFor(0)).toBeCloseTo(AUTO_THRESHOLD / 10)
  })
})

/** A cheap model that answers `answer` (or fails with it) and remembers what it was asked. */
const scripted = (answer: string | Error) => {
  const calls: string[] = []
  return {
    calls,
    complete: async (_system: string, user: string) => {
      calls.push(user)
      if (answer instanceof Error) throw answer
      return answer
    },
  }
}
describe('automatic retrieval', () => {
  it('injects what the rerank selects and records it under the input it served', async () => {
    const { index } = fixture()
    const model = scripted('{"ids":[1],"none":false}')
    const retrieval = serviceOf(new ChatRetrieval(index, model, () => 9))
    const use = await Effect.runPromise(
      retrieval.automatic({ session: '1', chat: '1' }, { entry: 2, text: 'What about the tomatoes in raised beds?' }),
    )
    expect(use).toMatchObject({ id: autoUseId('1', 2), mode: 'auto', inputEntry: 2, chat: '1' })
    expect(use?.sources).toHaveLength(1)
    expect(model.calls[0]).toContain('raised beds')
    expect(index.uses('1')).toEqual([use])
  })
  it('abstains when the rerank says none, answers badly or fails, and records nothing', async () => {
    for (const answer of ['{"ids":[],"none":true}', 'I think 1', new Error('provider down')]) {
      const { index } = fixture()
      const retrieval = serviceOf(new ChatRetrieval(index, scripted(answer), () => 9))
      expect(
        await Effect.runPromise(
          retrieval.automatic({ session: '1', chat: '1' }, { entry: 2, text: 'tomatoes raised beds' }),
        ),
      ).toBeUndefined()
      expect(index.uses('1')).toEqual([])
    }
  })
  it('asks no model when nothing passes the bm25 gate', async () => {
    const { index } = fixture()
    await indexAll(index)
    const model = scripted('{"ids":[1],"none":false}')
    const weak = index.search('tomatoes', { limit: 8 }).map((found) => ({ ...found, score: 0 }))
    expect(await chooseSources('tomatoes', weak, -1, model)).toEqual([])
    expect(model.calls).toEqual([])
  })
})

describe('search_chats', () => {
  it('searches with a frozen result per tool call', async () => {
    const { index } = fixture()
    const retrieval = serviceOf(new ChatRetrieval(index, scripted('{"ids":[],"none":true}'), () => 9))
    const search = (query: string, useId: string, topic?: number) =>
      Effect.runPromise(
        retrieval.search({ query, ...(topic === undefined ? {} : { topic }) }, { session: '1', chat: '1', useId }),
      )
    const first = await search('tomatoes', 'tool:1:c1')
    expect(first.map((found) => found.chat).toSorted()).toEqual(['10', '13', '50'])
    expect(await search('japan', 'tool:1:c1')).toEqual(first)
    expect(await search('tomatoes', 'tool:1:c2', 3)).toMatchObject([{ chat: '20', topicName: 'Old' }])
  })
})
