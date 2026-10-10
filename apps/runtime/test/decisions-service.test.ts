import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { describe, expect, it } from 'vitest'
import { Decisions } from '../src/decisions/service.ts'
import { storedProposal } from '../src/decisions/store.ts'
import { appDecisionLabels } from '../src/storage/decision-schema.ts'
import { answering, decisionsFixture, entry } from './decisions-services.ts'

const UNDECIDED = 'The comparison has a useful new update.'
/** Clef sure of a highlight and of a thread. */
const sure = answering((question, option) =>
  question.endsWith('.attention')
    ? option === 'highlight'
      ? 0.85
      : 0.05
    : option === 'suggest-thread'
      ? 0.9
      : 0.1 / 5,
)

/** Main (chat and session 1) with the owner's message and goblin's answer, and an open thread. */
function personal(options: Parameters<typeof decisionsFixture>[0] = {}) {
  const f = decisionsFixture(options)
  f.sqlite.exec(`INSERT INTO app_conversations (session_id, pi_session, role, kind, title, created_at, topic_id) VALUES
    ('1', '1', 'primary', 'main', NULL, 1, 1), ('5', '5', NULL, 'thread', 'Flights', 1, 1)`)
  f.say(
    '1',
    entry(2, '1', 'pi.user', 'Compare the trip options, a separate angle on the budget'),
    entry(3, '1', 'pi.assistant', 'Here are both options.'),
  )
  f.state.answer = sure
  return f
}

const report = (relayId: string, text = UNDECIDED, complete = true) =>
  Decisions.use((decisions) => decisions.afterReport({ session: '1', relayId, text, complete }))
const label = (id: string, as: 'confirm' | 'dismiss') => Decisions.use((decisions) => decisions.label(id, as))

describe('decisions after a Delegate report', () => {
  it('judges a report once per relay, keeps the proposal and tells the feed', async () => {
    const f = personal()
    await f.run(report('r1'))
    await f.run(Effect.all([report('r1'), report('r1')], { concurrency: 'unbounded' }))
    expect(f.state.calls).toBe(1)
    expect(f.changed).toEqual(['dp_report_r1'])
    expect(await f.run(Decisions.use((decisions) => decisions.list))).toEqual([
      expect.objectContaining({
        id: 'dp_report_r1',
        chatId: '1',
        kind: 'attention-triage',
        provider: 'cloudflare/clef',
        probability: 0.85,
        state: 'open',
        payload: { type: 'highlight', relayId: 'r1', text: UNDECIDED },
      }),
    ])
    expect(f.flows).toEqual([{ flow: 'decision_propose', via: 'system', actor: 'agent', chat: '1', status: 'ok' }])
  })

  it('never ranks a question, an approval or a failure, nor an unfinished report', async () => {
    const f = personal()
    await f.run(report('q', 'Which of the two should I book?'))
    await f.run(report('failed', 'It failed: the site was down.'))
    await f.run(report('open', UNDECIDED, false))
    expect(f.state.calls).toBe(0)
    expect(f.changed).toEqual([])
  })

  it('without an AI binding judges nothing, not even what the rules alone would decide', async () => {
    const f = personal({ clef: 'unbound' })
    await f.run(report('r1', 'The flight is cancelled tonight.'))
    await f.run(Decisions.use((decisions) => decisions.afterYield('1')))
    expect(f.changed).toEqual([])
    expect(f.charged).toEqual([])
    expect(f.reported).toEqual([])
    expect(f.flows).toEqual([])
  })

  it('records a refused judgment as a flow and makes no call while the budget is spent', async () => {
    const f = personal()
    f.state.exhausted = true
    await f.run(report('r1'))
    expect(f.state.calls).toBe(0)
    expect(f.flows).toEqual([
      {
        flow: 'decision_propose',
        via: 'system',
        actor: 'agent',
        chat: '1',
        status: 'refused',
        errorType: 'BudgetExhausted',
      },
    ])
  })

  it('discards a result the chat moved past while Clef judged it, and keeps its charge', async () => {
    const f = personal()
    f.state.during = () => {
      f.sqlite.exec("UPDATE app_conversations SET epoch = epoch + 1 WHERE session_id = '1'")
    }
    await f.run(report('r1'))
    expect(f.state.calls).toBe(1)
    expect(storedProposal(f.db, 'dp_report_r1')).toBeUndefined()
    expect(f.charged.map(({ use, model }) => [use.input, model])).toEqual([[1000, 'clef']])
  })
})

describe("the owner's label", () => {
  it('keeps the first label: the same again answers the same, the other conflicts', async () => {
    const f = personal()
    await f.run(report('r1'))
    await f.run(report('r2'))
    const confirmed = await f.run(label('dp_report_r1', 'confirm'))
    expect(confirmed).toMatchObject({ state: 'confirmed', decidedAt: expect.any(Number) })
    expect(await f.run(label('dp_report_r1', 'confirm'))).toEqual(confirmed)
    expect(await f.run(Effect.flip(label('dp_report_r1', 'dismiss')))).toMatchObject({
      _tag: 'Conflict',
      reason: 'settled',
    })
    expect(await f.run(label('dp_report_r2', 'dismiss'))).toMatchObject({ state: 'dismissed' })
    expect(await f.run(Effect.flip(label('dp_none', 'confirm')))).toMatchObject({ _tag: 'NotFound' })
    expect(
      f.db
        .select()
        .from(appDecisionLabels)
        .all()
        .map(({ proposalId, label: kept }) => [proposalId, kept]),
    ).toEqual([
      ['dp_report_r1', 'confirm'],
      ['dp_report_r2', 'dismiss'],
    ])
    expect((await f.run(Decisions.use((decisions) => decisions.list))).map(({ id }) => id)).toEqual(['dp_report_r1'])
    expect(f.flows.slice(2).map(({ flow, status, errorType }) => [flow, status, errorType])).toEqual([
      ['decision_confirm', 'ok', undefined],
      ['decision_confirm', 'replayed', undefined],
      ['decision_dismiss', 'refused', 'Conflict'],
      ['decision_dismiss', 'ok', undefined],
      ['decision_confirm', 'refused', 'NotFound'],
    ])
  })

  it('refuses to confirm a proposal whose chat moved on, and makes it stale', async () => {
    const f = personal()
    await f.run(report('r1'))
    f.sqlite.exec("UPDATE app_conversations SET epoch = epoch + 1 WHERE session_id = '1'")
    expect(await f.run(Effect.flip(label('dp_report_r1', 'confirm')))).toMatchObject({
      _tag: 'Conflict',
      reason: 'stale',
    })
    expect(await f.run(Decisions.use((decisions) => decisions.view('dp_report_r1')))).toMatchObject({ state: 'stale' })
    expect(f.changed).toEqual(['dp_report_r1', 'dp_report_r1'])
  })
})

describe('decisions after an owner exchange', () => {
  it('suggests a thread, fenced on the exchange it judged, which a newer exchange makes stale', async () => {
    const f = personal()
    await f.run(Decisions.use((decisions) => decisions.afterYield('1')))
    const [suggestion] = await f.run(Decisions.use((decisions) => decisions.list))
    expect(suggestion).toMatchObject({
      id: expect.stringMatching(/^dp_thread_1_[0-9a-f]{64}$/u),
      kind: 'separate-work',
      payload: { type: 'thread-draft', title: 'Compare the trip options, a separate angle on the budget' },
      subject: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    })
    expect(storedProposal(f.db, suggestion?.id ?? '')?.fence).toEqual({
      session: '1',
      epoch: 0,
      evidence: suggestion?.subject,
    })
    f.say('1', entry(4, '1', 'pi.user', 'Never mind, back to the plan.'))
    expect(await f.run(Effect.flip(label(suggestion?.id ?? '', 'confirm')))).toMatchObject({ reason: 'stale' })
  })

  it("judges nothing when the newest message is not the owner's own", async () => {
    const f = personal()
    f.say('1', entry(4, '1', 'pi.user', 'A separate angle from my phone', 'Telegram'))
    await f.run(Decisions.use((decisions) => decisions.afterYield('1')))
    expect(f.state.calls).toBe(0)
    expect(await f.run(Decisions.use((decisions) => decisions.chosenContext('1')))).toEqual(Option.none())
  })
})
