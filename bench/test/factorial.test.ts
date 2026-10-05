import { expect, test } from 'vitest'
import { dataset } from '../src/fixtures.ts'
import { starterManifest } from '../src/manifest.ts'
import { episodes } from '../src/plan.ts'
import { factorial } from '../src/factorial.ts'
import { semanticSummary } from '../src/semantic.ts'
import type { RunData } from '../src/results.ts'

const score = {
  factualCorrect: true,
  evidenceComplete: true,
  evidenceValid: true,
  abstentionCorrect: true,
  unsupported: false,
}
function fixture(): RunData {
  const scenario = {
    ...dataset()[0]!,
    probes: dataset()[0]!
      .probes.slice(0, 3)
      .map((probe, index) => ({
        ...probe,
        category: (['latest-state', 'evidence', 'abstention'] as const)[index] ?? 'evidence',
        label: {
          requiredClaims: [],
          evidenceIds: [],
          mustAbstain: probe.category === 'abstention',
          prohibitedClaims: [],
          rubric: 'fixture',
        },
      })),
  }
  const manifest = {
    ...starterManifest(),
    scenarioIds: [scenario.id],
    corpus: { path: 'fixture', sha256: 'corpus' },
    variants: [
      { id: 'standard', policy: 'standard' as const, reader: 'deepseek-v4-pro-0813' },
      { id: 'standard-search', policy: 'standard-search' as const, reader: 'deepseek-v4-pro-0813' },
      { id: 'optchat', policy: 'optchat' as const, writer: 'deepseek-v4-pro-0813', reader: 'deepseek-v4-pro-0813' },
      {
        id: 'optchat-search',
        policy: 'optchat-search' as const,
        writer: 'deepseek-v4-pro-0813',
        reader: 'deepseek-v4-pro-0813',
      },
    ],
  }
  const results = episodes(manifest, [scenario]).map((episode) => ({
    id: episode.id,
    variant: episode.variant.id,
    category: episode.probe.category,
    status: 'completed' as const,
    answer: null,
    rawAnswer: 'fixture',
    score: { correct: true, evidenceComplete: true, evidenceValid: true, abstentionCorrect: true, unsupported: false },
    malformed: false,
    futureLeakage: false,
    unauthorizedReads: false,
    forbiddenEndorsement: false,
    deliveredIds: [],
    detail: '',
  }))
  const votes = results.map((result) => ({
    voteId: `human-${result.id}`,
    packetId: 'packet',
    caseId: result.id,
    kind: 'human' as const,
    reviewer: 'reviewer',
    rationale: 'fixture',
    evidenceIds: [],
    searchSupported: false,
    score,
    resolves: [],
    at: '2026-10-05T00:00:00Z',
    runId: 'factor',
    sourceHash: 'source',
    corpusHash: 'corpus',
    episodeId: result.id,
    resultHash: '',
    packetHash: '',
  }))
  return {
    resolved: {
      manifest,
      scenarios: [scenario],
      runId: 'factor',
      sourceHash: 'source',
      corpusHash: 'corpus',
      mode: 'live',
      createdAt: '',
    },
    results,
    traces: [],
    semanticVotes: votes.flatMap((vote) => [
      vote,
      { ...vote, kind: 'machine', reviewer: 'machine', voteId: `machine-${vote.episodeId}` },
    ]),
  }
}
test('factorial report exposes memory and search effects separately', () => {
  const report = factorial(fixture())
  expect(report.comparisons).toHaveLength(4)
  expect(report.comparisons.map((item) => item.effect)).toEqual(['memory', 'memory', 'search', 'search'])
  expect(report.comparisons.every((item) => item.gains === 0 && item.losses === 0)).toBe(true)
  expect(Object.values(semanticSummary(fixture()))[0]).toMatchObject({ resolved: 3, semanticPasses: 3 })
})

test('two paired semantic gains need full coverage and no regressions; search gains need receipts', () => {
  const data = fixture()
  const votes = (data.semanticVotes ?? []).map((vote) => {
    const category = data.results.find((result) => result.id === vote.episodeId)?.category
    return {
      ...vote,
      score: { ...vote.score, factualCorrect: !vote.episodeId.endsWith('.standard') || category === 'abstention' },
    }
  })
  const candidate = { ...data, semanticVotes: votes }
  expect(factorial(candidate).comparisons[0]).toMatchObject({ gains: 2, losses: 0, promising: true })
  expect(factorial({ ...candidate, results: candidate.results.slice(1) }).comparisons[0]?.promising).toBe(false)
  const baseline = candidate.results.find((result) => result.variant === 'standard' && result.category === 'abstention')
  const loss = votes.map((vote) => ({
    ...vote,
    score: {
      ...vote.score,
      factualCorrect:
        vote.episodeId === baseline?.id.replace('.standard', '.optchat') ? false : vote.score.factualCorrect,
    },
  }))
  expect(factorial({ ...candidate, semanticVotes: loss }).comparisons[0]).toMatchObject({ losses: 1, promising: false })
  expect(factorial(candidate).comparisons[2]).toMatchObject({ gains: 2, searchSupportedGains: 0, promising: false })
})

test('shared build accounting counts settlement once and labels both amortization denominators', async () => {
  const { construction, semanticEfficiency } = await import('../src/construction.ts')
  const { artifactIdentity } = await import('../scripts/identity.ts')
  const data = fixture()
  const variant = data.resolved.manifest.variants.find((item) => item.policy === 'optchat')
  const scenario = data.resolved.scenarios?.[0]
  if (variant === undefined || scenario === undefined) throw new Error('Missing harness fixture')
  const record = {
    attempt: 1,
    scope: artifactIdentity(data.resolved, scenario.id, variant),
    phase: 'build' as const,
    model: variant.reader,
    status: 200,
    input: 120,
    output: 12,
    unknownUsage: false,
    at: '',
    request: '',
    response: '',
    latencyMs: 50,
  }
  const accounted = construction({
    ...data,
    traces: [{ ...record, status: 0, unknownUsage: true, input: 500 }, record],
  })
  const memory = accounted.memories.find((item) => item.memory === 'optchat')
  expect(memory).toMatchObject({
    arms: ['optchat', 'optchat-search'],
    apiAttempts: 1,
    chargedInput: 120,
    plannedAnswers: 6,
    completedAnswers: 6,
    amortizedPerPlanned: { input: 20 },
    amortizedPerCompleted: { input: 20 },
  })
  const partial = construction({ ...data, results: data.results.slice(0, 4), traces: [record] }).memories.find(
    (item) => item.memory === 'optchat',
  )
  expect(partial?.amortizedPerPlanned.input).toBe(20)
  expect(partial?.amortizedPerCompleted.input).toBe(60)
  expect(semanticEfficiency(data)['optchat']?.passesPerReaderApiAttempt).toBeNull()
})
