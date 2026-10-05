import { expect, test } from 'vitest'
import { dataset } from '../src/fixtures.ts'
import { starterManifest } from '../src/manifest.ts'
import { episodes } from '../src/plan.ts'
import { groundTruth, scoreProbe } from '../src/scoring.ts'
import { cost, promotion, renderReport } from '../src/report.ts'
import type { RunData } from '../src/results.ts'

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
