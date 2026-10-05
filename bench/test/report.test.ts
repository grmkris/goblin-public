import { expect, test } from 'vitest'
import { dataset } from '../src/fixtures.ts'
import { starterManifest } from '../src/manifest.ts'
import { episodes } from '../src/plan.ts'
import { groundTruth, scoreProbe } from '../src/scoring.ts'
import { cost, promotion, renderReport } from '../src/report.ts'
import type { RunData } from '../src/results.ts'
import type { Probe } from '../src/schema.ts'

function greenRun(): RunData {
  const manifest = {
    ...starterManifest(),
    split: 'held-out' as const,
    scenarioIds: ['verification', 'constraints', 'unknown'],
    variants: [{ id: 'candidate', policy: 'standard' as const, reader: 'glm-5.3' }],
  }
  const results = episodes(manifest).map((episode) => {
    const scenario = dataset().find((item) => item.id === episode.probe.scenarioId)
    if (scenario === undefined) throw new Error('missing fixture')
    const truth = groundTruth(scenario, episode.probe)
    const answer = {
      claims: truth.map(({ key, value }) => ({ key, value })),
      evidenceIds: truth.map(({ evidenceId }) => evidenceId),
      abstain: truth.length === 0,
    }
    return {
      id: episode.id,
      variant: episode.variant.id,
      category: episode.probe.category,
      status: 'completed' as const,
      answer,
      score: scoreProbe(scenario, episode.probe, answer, answer.evidenceIds),
      malformed: false,
      futureLeakage: false,
      unauthorizedReads: false,
      forbiddenEndorsement: false,
      deliveredIds: answer.evidenceIds,
      detail: '',
    }
  })
  return {
    resolved: {
      manifest,
      sourceHash: 'fixture-source',
      corpusHash: 'fixture-corpus',
      runId: 'green',
      mode: 'live',
      createdAt: '2026-10-05',
    },
    results,
    traces: [],
  }
}

test('promotion fails on fake evidence, missing episodes, invalid citations and category regressions', () => {
  const good = greenRun()
  expect(promotion(good, good).eligible).toBe(true)
  expect(promotion({ ...good, resolved: { ...good.resolved, mode: 'fake' } }, good).eligible).toBe(false)
  expect(promotion({ ...good, results: good.results.slice(1) }, good).eligible).toBe(false)
  const first = good.results[0]
  if (first === undefined) throw new Error('missing result')
  const changed = {
    ...good,
    results: [{ ...first, score: { ...first.score, correct: false } }, ...good.results.slice(1)],
  }
  expect(promotion(changed, good).reasons).toContain('A category regressed')
  expect(
    promotion(
      { ...good, results: [{ ...first, score: { ...first.score, evidenceValid: false } }, ...good.results.slice(1)] },
      good,
    ).eligible,
  ).toBe(false)
})
test('reports escape model text and unknown prices are not zero', () => {
  const good = greenRun()
  const report = renderReport({
    ...good,
    results: good.results.map((result) => ({ ...result, detail: '<script>alert(1)</script>' })),
  })
  expect(report).not.toContain('<script>')
  expect(report).toContain('&lt;script&gt;')
  expect(cost(good).runSpend).toBeNull()
})

test('paired diagnostics require complete reviewed coverage, a delivered search gain and no loss', async () => {
  const { paired } = await import('../src/paired.ts')
  const good = greenRun()
  const categories: readonly Probe['category'][] = ['latest-state', 'evidence', 'abstention']
  const scenario = {
    id: 'paired-fixture',
    family: 'paired-fixture',
    split: 'development' as const,
    events: [],
    probes: [22, 32].flatMap((cutoff) =>
      categories.map((category) => ({
        id: `pair.${cutoff}.${category}`,
        scenarioId: 'paired-fixture',
        cutoff,
        category,
        question: '',
        keys: [],
      })),
    ),
  }
  const manifest = {
    ...good.resolved.manifest,
    corpus: { path: 'private-fixture', sha256: '' },
    scenarioIds: [scenario.id],
    variants: [
      { id: 'base', policy: 'optchat' as const, writer: 'qwen3.8-flash', reader: 'grok-4.7' },
      { id: 'search', policy: 'optchat-search' as const, writer: 'qwen3.8-flash', reader: 'grok-4.7' },
    ],
  }
  const original = good.results[0]!
  // SAFETY: the fixture manifest's variants and scenario are constructed immediately above.
  const results = episodes(manifest, [scenario]).map((episode, index) => ({
    ...original,
    id: episode.id,
    variant: episode.variant.id,
    category: episode.probe.category,
    score: { ...original.score, correct: index !== 0 },
    reviewStatus: 'reviewed' as const,
    review: { reviewer: 'test', rationale: 'Injected report fixture only', classification: [], searchSupported: true },
    answer: { claims: [], evidenceIds: ['source'], abstain: false },
    deliveries: [
      {
        id: 'source',
        kind: 'user' as const,
        offsetBytes: 0,
        endBytes: 1,
        totalBytes: 1,
        text: 'x',
        origin: 'search' as const,
      },
    ],
  }))
  const data = { ...good, resolved: { ...good.resolved, manifest, scenarios: [scenario] }, results }
  expect(paired(data)[0]).toMatchObject({
    gains: 1,
    losses: 0,
    comparablePairs: 6,
    searchSupportedGains: 1,
    promising: true,
  })
  expect(paired({ ...data, results: results.slice(1) })[0]).toMatchObject({ promising: false, allReviewed: false })
  expect(paired({ ...data, results: results.map((result) => ({ ...result, deliveries: [] })) })[0]).toMatchObject({
    promising: false,
    searchSupportedGains: 0,
  })
  expect(
    paired({
      ...data,
      results: results.map((result, index) =>
        index === 3 ? { ...result, score: { ...result.score, correct: false } } : result,
      ),
    })[0],
  ).toMatchObject({ promising: false, losses: 1 })
})
