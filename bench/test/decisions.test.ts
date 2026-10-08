import { describe, expect, it } from 'vitest'
import { Effect, FileSystem } from 'effect'
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { decisionFixtures } from '../src/decisions/fixtures.ts'
import { questionsFor, chosen } from '../src/decisions/questions.ts'
import { Fixture, type Attempt, Row } from '../src/decisions/schema.ts'
import { models, type Manifest } from '../src/decisions/manifest.ts'
import { rules } from '../src/decisions/rules.ts'
import { packet, decodeAnswers, typedBody, openaiBody } from '../src/decisions/wire.ts'
import { admission, settle, totals } from '../src/decisions/budget.ts'
import { threshold, calibration, score, summarize } from '../src/decisions/scoring.ts'
import { batches, localRow, modelRows, plan } from '../src/decisions/runner.ts'
import { runDecisions } from '../scripts/decisions-run.ts'
import type { Provider } from '../scripts/decisions-provider.ts'
import { readLedger } from '../scripts/store.ts'
import { Attempt as AttemptSchema } from '../src/decisions/schema.ts'
import { combineRows } from '../src/decisions/report.ts'

const manifest: Manifest = {
  schemaVersion: 1,
  runId: 'test',
  fixtureHash: 'fixtures',
  sourceHash: 'source',
  repetitions: 3,
  batchSize: 2,
  prompt: 'test',
  questions: {},
  models: models('synthetic-account'),
  limits: {
    maxRequests: 2000,
    maxUsd: 3,
    maxInput: 8_000_000,
    maxOutput: 2_000_000,
    perCallInput: 16_000,
    perCallOutput: 1536,
  },
}
const fixture = (id: string): Fixture => {
  const found = decisionFixtures.find((item) => item.id === id)
  if (found === undefined) throw new Error('Missing test fixture')
  return found
}
const model = manifest.models[0]
if (model === undefined) throw new Error('Missing test model')
const reservation: Attempt = {
  id: 'test.1',
  runId: 'test',
  arm: 'cheap-llm',
  fixtureId: 'f',
  repetition: 1,
  phase: 'reserve',
  reservedInput: 1000,
  reservedOutput: 1536,
  input: 1000,
  output: 1536,
  costUsd: 0.00868,
  status: 0,
  error: null,
  usageKnown: false,
  latencyMs: 0,
}
const fileLayer = FileSystem.layerNoop({
  exists: (path) =>
    Effect.promise(() =>
      access(path).then(
        () => true,
        () => false,
      ),
    ),
  readFileString: (path) => Effect.promise(() => readFile(path, 'utf8')),
  writeFileString: (path, text, options) => Effect.promise(() => writeFile(path, text, options)),
  makeDirectory: (path, options) => Effect.promise(() => mkdir(path, options)).pipe(Effect.asVoid),
  remove: (path, options) => Effect.promise(() => rm(path, options)),
})
function checkFixture(item: Fixture) {
  const questions = questionsFor(item)
  expect(Object.keys(item.expected).toSorted()).toEqual(Object.keys(questions).toSorted())
  for (const [name, label] of Object.entries(item.expected)) expect(questions[name]?.options).toContain(label)
  if (item.task !== 'context-relevance') return
  expect(item.state.candidates.length).toBeGreaterThanOrEqual(3)
  expect(item.state.candidates.length).toBeLessThanOrEqual(8)
  const some = Object.entries(item.expected).some(([name, value]) => name !== 'none-relevant' && value === 'yes')
  expect(item.expected['none-relevant']).toBe(some ? 'no' : 'yes')
}

describe('decision fixtures and evidence boundaries', () => {
  it('has 40 bounded cases and all six categories per task with valid label choices', () => {
    expect(decisionFixtures).toHaveLength(160)
    expect(new Set(decisionFixtures.map((item) => item.id)).size).toBe(160)
    for (const task of ['context-relevance', 'brief-update', 'attention-triage', 'separate-work']) {
      const cases = decisionFixtures.filter((item) => item.task === task)
      expect(cases).toHaveLength(40)
      expect(new Set(cases.map((item) => item.category)).size).toBe(6)
      for (const item of cases) checkFixture(item)
    }
  })
  it('never allows labels to alter rules, state packets or selected critic cases', () => {
    const original = fixture('brief-update-02')
    const changed = {
      ...original,
      expected: { entry: 'none', duplicate: 'yes', conflict: 'yes' },
      rationale: 'POISONED-LABEL',
    }
    expect(rules(changed)).toEqual(rules(original))
    expect(packet([changed])).toEqual(packet([original]))
    expect(JSON.stringify(packet([changed]))).not.toContain('POISONED-LABEL')
    expect(batches([changed], 'critic', 1)[0]?.selected.length).toBe(
      batches([original], 'critic', 1)[0]?.selected.length,
    )
  })
  it('forces explicit opted-out archived references while excluding superseded auto-context', () => {
    const explicit = fixture('context-relevance-04')
    expect(chosen(rules(explicit).answers['c1'] ?? {})).toBe('yes')
    const stale = fixture('context-relevance-05')
    expect(chosen(rules(stale).answers['c1'] ?? {})).toBe('no')
  })
  it('does not mistake a quoted or tentative choice for a settled owner decision', () => {
    for (const id of ['brief-update-01', 'brief-update-03', 'brief-update-11'])
      expect(chosen(rules(fixture(id)).answers['entry'] ?? {})).toBe('none')
  })
})
describe('wire distributions', () => {
  const triage = fixture('attention-triage-01')
  const questions = packet([triage]).questions
  it('supports ordered score criteria and numeric-index provider probabilities', () => {
    const body = typedBody('clef', packet([triage]))
    const question = Object.values(body.questions)[0]
    expect(question?.criteria).toBeInstanceOf(Array)
    const answers = decodeAnswers(
      {
        result: {
          answers: {
            'attention-triage-01.attention': {
              type: 'score',
              score: 2.9,
              probabilities: { 0: 0.01, 1: 0.01, 2: 0.08, 3: 0.9 },
            },
          },
        },
      },
      questions,
    )
    expect(answers['attention-triage-01.attention']?.['highlight']).toBe(0.9)
  })
  it('supports OpenAI named score arrays and predicate translation', () => {
    const body = openaiBody(packet([fixture('context-relevance-01')]))
    expect(body.questions[0]?.type).toBe('predicate')
    const answers = decodeAnswers(
      {
        answers: [
          {
            name: 'attention-triage-01.attention',
            type: 'score',
            probabilities: [
              { label: 'quiet', value: 0, probability: 0 },
              { label: 'show-on-return', value: 1, probability: 0 },
              { label: 'recap', value: 2, probability: 0 },
              { label: 'highlight', value: 3, probability: 1 },
            ],
          },
        ],
      },
      questions,
    )
    expect(chosen(answers['attention-triage-01.attention'] ?? {})).toBe('highlight')
  })
  it('rejects incomplete, unknown, nonfinite and nonnormalized distributions without inventing confidence', () => {
    for (const raw of [
      { score: 3 },
      { probabilities: { highlight: 1 } },
      { probabilities: { quiet: 0, 'show-on-return': 0, recap: 0, highlight: 2 } },
      { probabilities: { quiet: 0, 'show-on-return': 0, recap: 0, highlight: 0 } },
    ])
      expect(() => decodeAnswers({ answers: { 'attention-triage-01.attention': raw } }, questions)).toThrow()
  })
  it('keeps identical evidence across typed models and the critic subset', () => {
    const cases = [fixture('brief-update-01'), fixture('brief-update-07')]
    expect(packet(cases, cases.slice(1)).state).toBe(packet(cases).state)
  })
})
describe('scoring and calibration', () => {
  it('fits a binary positive threshold without using expected-answer probabilities', () => {
    const observations = [
      { probability: 0.9, positive: true },
      { probability: 0.8, positive: true },
      { probability: 0.7, positive: true },
      { probability: 0.75, positive: false },
      { probability: 0.1, positive: false },
    ]
    expect(threshold(observations)).toEqual({ value: 0.7, precision: 0.75, recall: 1, positive: 3, selected: 4 })
    expect(threshold([{ probability: 0.5, positive: false }])).toBeNull()
  })
  it('calibrates chosen confidence rather than the probability of the expected answer', () => {
    const item = fixture('attention-triage-01')
    const row: Row = {
      ...localRow(item, 'rules', 1),
      answers: { attention: { quiet: 0.9, 'show-on-return': 0.02, recap: 0.03, highlight: 0.05 } },
    }
    const result = score(item, row)
    expect(result?.details[0]?.confidence).toBe(0.9)
    expect(result?.missedHighlight).toBe(1)
    expect(calibration(result?.details ?? [])[4]?.correctness).toBe(0)
  })
  it('counts provider failures separately and keeps costs for failed calls', () => {
    const item = fixture('attention-triage-01')
    const row: Row = {
      ...localRow(item, 'clef', 1),
      route: 'model',
      error: 'http-503',
      answers: null,
      costUsd: 0.01,
      actualCostUsd: null,
    }
    const result = summarize([item], [row])
    expect(result.accuracy).toBeNull()
    expect(result.providerErrors).toBe(1)
    expect(result.chargedUsd).toBe(0.01)
    expect(result.actualCostUsd).toBeNull()
  })
  it('allocates one request cost once across its judged cases', () => {
    const group = batches([fixture('attention-triage-01'), fixture('attention-triage-02')], 'clef', 1)[0]
    if (group === undefined) throw new Error('Missing batch')
    const rows = modelRows(group, {
      answers: {},
      error: 'invalid-answer',
      latencyMs: 400,
      input: 100,
      output: 0,
      costUsd: 0.02,
      actualCostUsd: 0.02,
    })
    expect(rows.reduce((sum, row) => sum + row.costUsd, 0)).toBe(0.02)
  })
})
describe('durable admission', () => {
  it('preserves prior-run spend while allowing a fresh explicit run after a known envelope breach', () => {
    const prior = settle(reservation, model, { status: 200, latencyMs: 10, error: null }, { input: 1001, output: 20 })
    expect(admission(manifest, [prior], model, 100, 20)).toBe('reservation-breach')
    const fresh = { ...manifest, runId: 'fresh' }
    expect(admission(fresh, [prior], model, 100, 20)).toBeNull()
    expect(admission({ ...fresh, limits: { ...fresh.limits, maxUsd: prior.costUsd } }, [prior], model, 100, 20)).toBe(
      'budget-ceiling',
    )
  })
  it('plans only manifest-selected arms and keeps the provider output token envelope', () => {
    const output = plan({ ...manifest, selectedArms: ['jev', 'openai-decisions'] }, decisionFixtures)
    expect(output.requests).toBe(480)
    expect(output.estimates.map((item) => item.arm)).toEqual(['jev', 'openai-decisions'])
  })
  it('includes critic calls and full completion reservations in the dry-run budget', () => {
    const output = plan({ ...manifest, limits: { ...manifest.limits, perCallOutput: 512 } }, decisionFixtures)
    expect(output.requests).toBeLessThanOrEqual(2000)
    expect(output.criticRequests).toBeGreaterThan(0)
    expect(output.maximumReservedUsd).toBeLessThan(3)
    expect(output.estimatedInput).toBe(output.estimates.reduce((sum, item) => sum + item.estimatedInput, 0))
  })
  it('counts reservation and settlement once and fails closed on unfinished or unknown usage', () => {
    expect(admission(manifest, [reservation], model, 100, 100)).toBe('unfinished-attempt')
    const finished = settle(
      reservation,
      model,
      { status: 200, latencyMs: 100, error: null },
      { input: 100, output: 20 },
    )
    expect(totals([reservation, finished]).requests).toBe(1)
    expect(admission(manifest, [reservation, finished], model, 100, 100)).toBeNull()
    const unknown = settle(reservation, model, { status: 0, latencyMs: 100, error: 'timeout' }, undefined)
    expect(admission(manifest, [reservation, unknown], model, 100, 100)).toBe('unknown-usage')
    expect(unknown.costUsd).toBe(reservation.costUsd)
  })
  it('refuses requests before request, dollar or token ceilings can be crossed', () => {
    expect(admission({ ...manifest, limits: { ...manifest.limits, maxUsd: 0.001 } }, [], model, 1000, 1536)).toBe(
      'budget-ceiling',
    )
    expect(admission(manifest, [], model, 16_001, 0)).toBe('per-call-token-ceiling')
    const finished = settle(
      reservation,
      model,
      { status: 200, latencyMs: 100, error: null },
      { input: 1001, output: 0 },
    )
    expect(finished.error).toBe('reservation-breach')
    expect(admission(manifest, [finished], model, 100, 0)).toBe('reservation-breach')
  })
})
const trials = [fixture('attention-triage-03'), fixture('attention-triage-04')]
const injectedAnswers = Object.fromEntries(
  trials.flatMap((item) => Object.entries(rules(item).answers).map(([name, value]) => [item.id + '.' + name, value])),
)
const runInjected = (root: string, provider: Provider) =>
  Effect.runPromise(
    runDecisions({
      root,
      manifest,
      fixtures: trials,
      provider,
      available: () => Effect.succeed(true),
      status: () => Effect.void,
      steer: Effect.void,
    }).pipe(Effect.scoped, Effect.provide(fileLayer)),
  )
it('settles three repetitions of all six remote arms and persists every row exactly once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goblin-decisions-success-'))
  let calls = 0
  const provider: Provider = ({ model: route }) => {
    calls += 1
    const answer = { answers: injectedAnswers }
    const body =
      route.arm === 'cheap-llm'
        ? {
            choices: [{ message: { content: JSON.stringify(answer) } }],
            usage: { prompt_tokens: 100, completion_tokens: 20 },
          }
        : { ...answer, usage: { input_tokens: 100, output_tokens: 20 } }
    return Effect.succeed({ status: 200, text: JSON.stringify(body), latencyMs: 5, error: null })
  }
  try {
    const result = await runInjected(root, provider)
    expect(result.halted).toBe(false)
    expect(calls).toBe(18)
    expect(result.rows).toHaveLength(42)
    expect(result.rows.filter((row) => row.route === 'model')).toHaveLength(36)
    expect(totals(result.records).requests).toBe(18)
    const persisted = await Effect.runPromise(
      readLedger(join(root, 'test/results.jsonl'), Row).pipe(Effect.provide(fileLayer)),
    )
    expect(persisted).toHaveLength(42)
    expect(new Set(persisted.map((row) => [row.id, row.arm, row.repetition].join('/'))).size).toBe(42)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
it('retains a timeout reservation and halts every later provider admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goblin-decisions-timeout-'))
  let calls = 0
  const provider: Provider = () => {
    calls += 1
    return Effect.succeed({ status: 0, text: '', latencyMs: 30000, error: 'timeout' })
  }
  try {
    const result = await runInjected(root, provider)
    expect(result.halted).toBe(true)
    expect(calls).toBe(1)
    expect(result.rows).toHaveLength(42)
    expect(result.records.at(-1)?.usageKnown).toBe(false)
    expect(result.records.at(-1)?.input).toBe(result.records[0]?.reservedInput)
    expect(
      summarize(
        trials,
        result.rows.filter((row) => row.arm === 'critic'),
      ).timeouts,
    ).toBe(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
it('combines explicitly included rows once with later matching rows taking precedence', () => {
  const initial = localRow(fixture('attention-triage-03'), 'jev', 1)
  const replacement = { ...initial, latencyMs: 77 }
  const other = localRow(fixture('attention-triage-04'), 'jev', 1)
  expect(combineRows([[initial, other], [replacement]])).toEqual([replacement, other])
})
it('runs with injected providers, retains 403 once, makes no retry and persists private reservations before dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goblin-decisions-test-'))
  let calls = 0
  const provider: Provider = (_request) =>
    Effect.gen(function* () {
      calls += 1
      const text = yield* Effect.promise(() => readFile(join(root, 'attempts.jsonl'), 'utf8'))
      expect(JSON.parse(text.trim().split('\n').at(-1) ?? '{}').phase).toBe('reserve')
      return { status: 403, text: '{"error":"forbidden"}', latencyMs: 7, error: 'http-403' }
    })
  try {
    const result = await Effect.runPromise(
      runDecisions({
        root,
        manifest,
        fixtures: [fixture('attention-triage-03'), fixture('attention-triage-04')],
        provider,
        available: () => Effect.succeed(true),
        status: () => Effect.void,
        steer: Effect.void,
      }).pipe(Effect.scoped, Effect.provide(fileLayer)),
    )
    expect(result.halted).toBe(false)
    expect(calls).toBe(6)
    expect(result.rows).toHaveLength(42)
    expect(result.records.filter((item) => item.phase === 'reserve')).toHaveLength(6)
    expect(totals(result.records).usd).toBeGreaterThan(0)
    expect(result.records.filter((item) => item.phase === 'settle').every((item) => !item.usageKnown)).toBe(true)
    expect(result.rows.filter((item) => item.error === 'http-403' && item.route === 'model')).toHaveLength(12)
    expect((await stat(join(root, 'attempts.jsonl'))).mode & 0o077).toBe(0)
    const fsProgram = Effect.gen(function* () {
      const records = yield* readLedger(join(root, 'attempts.jsonl'), AttemptSchema)
      expect(totals(records).requests).toBe(6)
      expect((yield* readLedger(join(root, 'test/results.jsonl'), Row)).length).toBe(42)
    })
    await Effect.runPromise(fsProgram.pipe(Effect.provide(fileLayer)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
