import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'
import { Budget } from '../src/budget.ts'
import { threadTitle } from '../src/decisions/candidates.ts'
import { Clef, workersClef } from '../src/decisions/client.ts'
import { type CriticDeps, type Judgment, judge } from '../src/decisions/critic.ts'
import { decodeAnswers } from '../src/decisions/wire.ts'
import { BudgetExhausted, ResidentInactive } from '../src/http/errors.ts'
import { Resident } from '../src/mcp/service.ts'
import type { AuxCall } from '../src/telemetry/report.ts'
import { currentResident } from './fixed-services.ts'

const item = (text = 'The comparison has a useful new update.'): Judgment => ({
  id: 'dp_report_123',
  chatId: '1',
  subject: '123',
  ordinary: true,
  current: Effect.succeed(true),
  fence: { session: '1', epoch: 0 },
  case: {
    id: 'report',
    task: 'attention-triage',
    state: { focus: 'Trip', result: text, runtimeKind: 'delegate-result' },
  },
  payload: { type: 'highlight', relayId: '123', text },
})
const answer = {
  answers: { 'report.attention': { probabilities: { '0': 0.05, '1': 0.05, '2': 0.05, '3': 0.85 } } },
  usage: { input_tokens: 1000, output_tokens: 0 },
}

type Mode = 'ok' | 'budget' | 'resident' | 'unavailable' | 'malformed' | 'missing-usage'

/** The critic with Clef answering `answer` (or failing as `mode` says), its calls, charges and aux records kept. */
function critic(mode: Mode = 'ok') {
  const reported: AuxCall[] = []
  const charged: number[] = []
  const models = new Set<string | undefined>()
  let calls = 0
  const deps: CriticDeps = {
    report: (call) => void reported.push(call),
    resident: Resident.of({
      ...currentResident().service,
      require: () => (mode === 'resident' ? Effect.fail(new ResidentInactive({ state: 'revoked' })) : Effect.void),
    }),
    budget: Budget.of({
      today: () => Effect.die('the critic never reads the day'),
      require: () => (mode === 'budget' ? Effect.fail(new BudgetExhausted({ limit: 0, resetsAt: 0 })) : Effect.void),
      admit: () => Effect.die('the critic never admits a turn'),
      open: () => Effect.die('the critic never opens a turn'),
      record: (use, _now, model) =>
        Effect.sync(() => {
          models.add(model)
          charged.push(use.input)
        }),
    }),
    clef: Clef.of({
      available: mode !== 'unavailable',
      evaluate: () =>
        Effect.suspend(() => {
          calls += 1
          if (mode === 'unavailable') return workersClef(undefined).evaluate({ state: '', questions: {} })
          if (mode === 'malformed') return Effect.succeed({ usage: answer.usage })
          return Effect.succeed(mode === 'missing-usage' ? { answers: answer.answers } : answer)
        }),
    }),
  }
  const run = (judged: Judgment) => Effect.runPromise(judge(deps, judged))
  const failure = (judged: Judgment) => Effect.runPromise(Effect.flip(judge(deps, judged)))
  return { run, failure, reported, charged, models, calls: () => calls }
}

describe('the typed decision critic (ADR 0031)', () => {
  it('lets the state-only rules decide without a provider call', async () => {
    const f = critic()
    expect(await f.run(item('The flight is cancelled tonight.'))).toMatchObject({ provider: 'rules', state: 'open' })
    expect(f.calls()).toBe(0)
    expect(f.charged).toEqual([])
  })

  it('asks Clef only for an undecided case, and charges and records the call without its content', async () => {
    const f = critic()
    expect(await f.run(item())).toMatchObject({
      id: 'dp_report_123',
      kind: 'attention-triage',
      provider: 'cloudflare/clef',
      probability: 0.85,
      state: 'open',
    })
    expect(f.calls()).toBe(1)
    expect(f.charged).toEqual([1000])
    expect([...f.models]).toEqual(['clef'])
    expect(f.reported[0]?.message).toMatchObject({ model: 'cloudflare/clef', stopReason: 'stop' })
    expect(JSON.stringify(f.reported)).not.toContain('useful new update')
  })

  it.each(['budget', 'resident'] as const)('makes no call when %s prevents it', async (mode) => {
    const f = critic(mode)
    expect(await f.failure(item())).toMatchObject({ _tag: mode === 'budget' ? 'BudgetExhausted' : 'ResidentInactive' })
    expect(f.calls()).toBe(0)
    expect(f.charged).toEqual([])
  })

  it('discards a stale result and keeps its charge', async () => {
    const f = critic()
    expect(await f.run({ ...item(), current: Effect.succeed(false) })).toBeUndefined()
    expect(f.charged).toEqual([1000])
  })

  it('charges nothing when no binding answered', async () => {
    const f = critic('unavailable')
    expect(await f.failure(item())).toMatchObject({ _tag: 'ClefError', reason: 'unavailable' })
    expect(f.charged).toEqual([])
    expect(f.reported).toEqual([])
  })

  it('charges a malformed answer and proposes nothing; an answer without usage is charged its whole reservation', async () => {
    const bad = critic('malformed')
    expect(await bad.failure(item())).toMatchObject({ _tag: 'ClefError', reason: 'format' })
    expect(bad.charged).toEqual([1000])
    expect(bad.reported[0]?.message?.stopReason).toBe('error')
    const unknown = critic('missing-usage')
    expect(await unknown.run(item())).toBeDefined()
    expect(unknown.charged).toEqual([65_536])
  })

  it('lets quiet decline a proposal, and rejects incomplete or unnormalized distributions', async () => {
    expect(await critic().run(item('Routine typo cleanup.'))).toBeUndefined()
    const question = {
      attention: { type: 'choice' as const, options: ['quiet', 'highlight'], instructions: '', criteria: {} },
    }
    expect(() => decodeAnswers({ answers: { attention: { quiet: 0.2 } } }, question)).toThrow()
    expect(() => decodeAnswers({ answers: { attention: { quiet: 0.8, highlight: 0.8 } } }, question)).toThrow()
  })
})

describe('Clef through the Workers AI binding', () => {
  it("sends the binding's wire, without the options, and is unavailable without a binding", async () => {
    let seen = ''
    const clef = workersClef({
      run: async (model, input) => {
        seen = JSON.stringify({ model, input })
        return answer
      },
    })
    expect(clef.available).toBe(true)
    await Effect.runPromise(
      clef.evaluate({
        state: 'evidence',
        questions: { yes: { type: 'noul', instructions: 'Judge', options: ['yes', 'no'], criteria: {} } },
      }),
    )
    expect(seen).toContain('@cf/cloudflare/clef')
    expect(seen).not.toContain('options')
    const unbound = workersClef(undefined)
    expect(unbound.available).toBe(false)
    expect(await Effect.runPromise(Effect.flip(unbound.evaluate({ state: '', questions: {} })))).toMatchObject({
      reason: 'unavailable',
    })
  })

  it('turns a refused call into a provider failure', async () => {
    const clef = workersClef({ run: () => Promise.reject(new Error('quota')) })
    expect(await Effect.runPromise(Effect.flip(clef.evaluate({ state: '', questions: {} })))).toMatchObject({
      reason: 'provider',
    })
  })
})

describe('a suggested thread title', () => {
  it("keeps the owner's short message on one line", () => {
    expect(threadTitle('  Find flights\n to Kyoto  ')).toBe('Find flights to Kyoto')
    expect(threadTitle(' \n ')).toBe('New thread')
  })

  it('cuts a long message after a whole word, with an ellipsis, within 60 characters', () => {
    const title = threadTitle('Can you also compare apartment prices in Lisbon vs Porto for a three month stay?')
    expect(title).toBe('Can you also compare apartment prices in Lisbon vs Porto…')
    expect(title.length).toBeLessThanOrEqual(60)
    expect(threadTitle('x'.repeat(80))).toBe(`${'x'.repeat(59)}…`)
  })
})
