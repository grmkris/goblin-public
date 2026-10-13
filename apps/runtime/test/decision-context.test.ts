import type { DecisionProposal, RetrievalSource } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { describe, expect, it } from 'vitest'
import { Budget } from '../src/budget.ts'
import { Clef } from '../src/decisions/client.ts'
import { contextCandidates, contextCase } from '../src/decisions/context.ts'
import { type Judgment, judge } from '../src/decisions/critic.ts'
import { Decisions } from '../src/decisions/service.ts'
import { addProposal, decideProposal } from '../src/decisions/store.ts'
import { KeyedLock } from '../src/observability/lock.ts'
import { recordUse, recordedUses } from '../src/retrieval/index.ts'
import { currentResident } from './fixed-services.ts'
import { decisionsFixture, entry } from './decisions-services.ts'

/**
 * Personal (chat 1) asks about raised beds; Garden (Topic 2, chat 10) discussed them; Old (Topic 3) is archived; a
 * Persona fork of Garden (40) and an unrelated thread (50).
 */
function garden() {
  const f = decisionsFixture()
  f.sqlite
    .exec(`INSERT INTO app_topics (id, name, chat_id, archived_at, search_excluded, created_by, created_at, updated_at) VALUES
    (2, 'Garden', '10', NULL, 0, 'owner', 1, 1), (3, 'Old', '20', 5, 0, 'owner', 1, 1)`)
  f.sqlite
    .exec(`INSERT INTO app_conversations (session_id, pi_session, role, kind, title, parent_session, created_at, topic_id) VALUES
    ('1', '1', 'primary', 'main', NULL, NULL, 1, 1),
    ('10', '10', 'conversation', 'main', 'Garden', NULL, 1, 2),
    ('20', '20', 'conversation', 'main', 'Old', NULL, 1, 3),
    ('40', '40', 'persona', 'thread', NULL, '10', 1, 2),
    ('50', '50', NULL, 'thread', 'Zebras', '1', 1, 1)`)
  f.say('1', entry(2, '1', 'pi.user', 'How deep should the raised beds for tomatoes be?'))
  f.say(
    '10',
    entry(11, '10', 'pi.user', 'We plan tomatoes and basil in raised beds'),
    entry(12, '10', 'pi.assistant', 'Raised beds need 30 cm of soil'),
  )
  f.say('20', entry(21, '20', 'pi.user', 'The old tomatoes raised beds greenhouse plan'))
  f.say('40', entry(41, '40', 'pi.user', 'tomatoes raised beds from a persona fork'))
  f.say('50', entry(51, '50', 'pi.user', 'Zebra stripes, quickly'))
  const candidates = (session: string) =>
    f.run(KeyedLock.use((lock) => contextCandidates({ db: f.db, source: f.transcripts }, lock, session, session)))
  return { ...f, candidates }
}

describe('cross-Topic context candidates', () => {
  it("searches the owner's other active chats for the newest message, never its own chat or an archived Topic", async () => {
    const f = garden()
    const found = await f.candidates('1')
    expect(found?.input).toEqual({ entry: 2, text: 'How deep should the raised beds for tomatoes be?' })
    expect(found?.sources.map(({ chat, topicName }) => [chat, topicName])).toEqual([['10', 'Garden']])
    expect(found?.sources[0]?.excerpt).toContain('30 cm of soil')
    const judged = contextCase(found?.input.text ?? '', found?.sources ?? [])
    expect(judged.state.candidates).toEqual([
      expect.objectContaining({ id: 'c1', topic: 'Garden', autoEnabled: true, archived: false, supersededBy: null }),
    ])
  })

  it('sets aside what automatic retrieval already gave the message', async () => {
    const f = garden()
    const [given] = (await f.candidates('1'))?.sources ?? []
    if (given === undefined) throw new Error('fixture source')
    recordUse(f.db, {
      id: 'auto:1:2',
      chat: '1',
      session: '1',
      inputEntry: 2,
      mode: 'auto',
      sources: [given],
      retrievedAt: 1,
    })
    expect(await f.candidates('1')).toBeUndefined()
  })

  it('offers nothing to a Persona fork or when nothing matches', async () => {
    const f = garden()
    expect(await f.candidates('40')).toBeUndefined()
    expect(await f.candidates('50')).toBeUndefined()
  })
})

const source = (chat: string, excerpt: string): RetrievalSource => ({
  topic: 2,
  topicName: 'Garden',
  chat,
  entryStart: 11,
  entryEnd: 12,
  excerpt,
  retrievedAt: 1,
  score: -2,
})

/** A context judgment of two Garden excerpts for the raised-beds question. */
function judgment(): Judgment {
  const first = source('10', 'Raised beds need 30 cm of soil for tomatoes')
  const second = source('11', 'Basil prices at the market')
  return {
    id: 'dp_context_1_abc',
    chatId: '1',
    subject: 'abc',
    ordinary: true,
    fence: { session: '1', epoch: 0, evidence: 'sha256:abc' },
    current: Effect.succeed(true),
    case: contextCase('How deep should the raised beds for tomatoes be?', [first, second]),
    payload: { type: 'context', inputEntry: 2, sources: [first, second] },
  }
}

/** The critic with Clef answering `answers` (yes probabilities per question). */
function critic(answers: Readonly<Record<string, number>>) {
  let calls = 0
  const deps = {
    report: () => undefined,
    resident: currentResident().service,
    budget: Budget.of({
      today: () => Effect.die('the critic never reads the day'),
      require: () => Effect.void,
      admit: () => Effect.die('the critic never admits a turn'),
      open: () => Effect.die('the critic never opens a turn'),
      record: () => Effect.void,
    }),
    clef: Clef.of({
      available: true,
      evaluate: (data) =>
        Effect.sync(() => {
          calls += 1
          return {
            usage: { input_tokens: 500, output_tokens: 0 },
            answers: Object.fromEntries(
              Object.keys(data.questions).map((name) => [name, { probability: answers[name] ?? 0 }]),
            ),
          }
        }),
    }),
  }
  return { judged: (item: Judgment) => Effect.runPromise(judge(deps, item)), calls: () => calls }
}

describe('the context critic', () => {
  it('proposes only the candidates Clef finds relevant at the frozen threshold', async () => {
    const { judged, calls } = critic({ 'context.c1': 0.9, 'context.c2': 0.5, 'context.none-relevant': 0.1 })
    const proposal = await judged(judgment())
    expect(calls()).toBe(1)
    expect(proposal).toMatchObject({ kind: 'context-relevance', provider: 'cloudflare/clef', probability: 0.9 })
    expect(proposal?.payload).toMatchObject({ type: 'context', inputEntry: 2, sources: [{ chat: '10' }] })
  })

  it('proposes nothing when no candidate clears the threshold', async () => {
    const { judged } = critic({ 'context.c1': 0.55, 'context.c2': 0.2, 'context.none-relevant': 0.8 })
    expect(await judged(judgment())).toBeUndefined()
  })

  it('lets the rules decide, without a call, when no candidate shares a word with the request', async () => {
    const { judged, calls } = critic({ 'context.c1': 1 })
    const unrelated = { ...judgment(), case: contextCase('Zebra stripes, quickly', [source('10', 'Raised beds')]) }
    expect(await judged(unrelated)).toBeUndefined()
    expect(calls()).toBe(0)
  })
})

/** The owner confirmed the context judgment at `decidedAt`. */
function chosen(f: ReturnType<typeof garden>, decidedAt: number) {
  const { id, chatId, subject, payload } = judgment()
  const proposal: DecisionProposal = {
    id,
    chatId,
    subject,
    payload,
    kind: 'context-relevance',
    state: 'open',
    probability: 0.9,
    provider: 'cloudflare/clef',
    createdAt: decidedAt,
  }
  addProposal(f.db, proposal, { session: '1', epoch: 0 })
  decideProposal(f.db, id, 'confirm', decidedAt)
}

const noteFor = (f: ReturnType<typeof garden>) =>
  f.run(Decisions.use((decisions) => decisions.chosenContext('1'))).then(Option.getOrUndefined)

describe('earlier work the owner chose to use', () => {
  it("joins the chat's requests as quoted history, recorded once for each later owner message it serves", async () => {
    const f = garden()
    expect(await noteFor(f)).toBeUndefined()
    chosen(f, Math.floor(Date.now() / 1000))
    const text = await noteFor(f)
    expect(text).toContain('The owner chose to use these excerpts')
    expect(text).toContain('Raised beds need 30 cm of soil for tomatoes')
    expect(recordedUses(f.db, '1')).toEqual([])
    f.say('1', entry(60, '1', 'pi.user', 'So 30 cm then, and what about the basil?'))
    await noteFor(f)
    await noteFor(f)
    expect(recordedUses(f.db, '1')).toEqual([
      expect.objectContaining({ id: 'decision:dp_context_1_abc:60', inputEntry: 60, mode: 'auto' }),
    ])
  })

  it('is forgotten a day after the owner chose it', async () => {
    const f = garden()
    chosen(f, Math.floor(Date.now() / 1000) - 25 * 60 * 60)
    expect(await noteFor(f)).toBeUndefined()
  })
})
