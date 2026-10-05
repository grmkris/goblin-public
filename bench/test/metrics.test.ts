import { expect, test } from 'vitest'
import { starterManifest } from '../src/manifest.ts'
import { episodes } from '../src/plan.ts'
import { answerMetrics, efficiency } from '../src/metrics.ts'
import { phaseAccounting, renderReport } from '../src/report.ts'
import { failedScore } from '../src/evaluate.ts'
import type { EpisodeResult, RunData, Trace } from '../src/results.ts'

function data(): RunData {
  const scenario = {
    id: 'metrics',
    family: 'metrics',
    split: 'development' as const,
    events: [],
    probes: ['one', 'two'].map((id) => ({
      id,
      scenarioId: 'metrics',
      cutoff: 1,
      category: 'evidence' as const,
      question: '',
      keys: [],
    })),
  }
  return {
    resolved: {
      manifest: {
        ...starterManifest(),
        scenarioIds: [scenario.id],
        variants: [{ id: 'base', policy: 'optchat', reader: 'glm-5.3' }],
        rates: [{ model: 'glm-5.3', inputPerMillion: 2, outputPerMillion: 4, dated: '2026-10-05' }],
      },
      scenarios: [scenario],
      sourceHash: 'source',
      corpusHash: 'corpus',
      runId: 'metrics-run',
      mode: 'live',
      createdAt: '2026-10-05',
    },
    results: [],
    traces: [],
  }
}
function trace(overrides: Partial<Trace> = {}): Trace {
  return {
    scope: 'metrics-run.one.base',
    model: 'glm-5.3',
    phase: 'answer',
    attempt: 1,
    status: 200,
    input: 10,
    output: 3,
    unknownUsage: false,
    request: '',
    response: '',
    at: '2026-10-05T00:00:00Z',
    latencyMs: 100,
    retryIndex: 0,
    ...overrides,
  }
}
function result(overrides: Partial<EpisodeResult> = {}): EpisodeResult {
  return {
    id: 'one.base',
    variant: 'base',
    category: 'evidence',
    status: 'completed',
    answer: null,
    score: failedScore,
    malformed: true,
    futureLeakage: false,
    unauthorizedReads: false,
    forbiddenEndorsement: false,
    deliveredIds: [],
    detail: '',
    ...overrides,
  }
}

test('settlement replaces reservation; retries, unknown usage and missing latency stay distinct', () => {
  const original = data()
  const value = answerMetrics(
    {
      ...original,
      traces: [
        trace({ status: 0, input: 50, output: 8, unknownUsage: true }),
        trace({ reasoningTokens: 2, cacheReadTokens: 0 }),
        trace({
          attempt: 2,
          status: 503,
          input: 20,
          output: 4,
          unknownUsage: true,
          retryIndex: 1,
          latencyMs: undefined,
        }),
        trace({ attempt: 3, phase: 'build', input: 999 }),
        trace({ attempt: 4, scope: 'metrics-run.two.base', input: 999 }),
      ],
    },
    'one.base',
  )
  expect(value).toMatchObject({
    outcome: 'unfinished',
    apiAttempts: 2,
    apiRetries: 1,
    retryCoverage: 2,
    successfulApiAttempts: 1,
    failedApiAttempts: 1,
    unknownUsageApiAttempts: 1,
    chargedInputTokens: 30,
    chargedOutputTokens: 7,
    reportedInputTokens: 10,
    reportedOutputTokens: 3,
    apiLatencyMs: 100,
    apiLatencyCoverage: 1,
    completeApiLatencyMs: null,
    reasoning: { total: 2, covered: 1 },
    cacheRead: { total: 0, covered: 1 },
    cacheWrite: { total: null, covered: 0 },
    toolCalls: null,
    answerMs: null,
    spend: null,
    pricedApiAttempts: 1,
  })
  expect(phaseAccounting({ ...original, traces: [trace()] }).base?.requests).toBe(1)
})

test('tool attempts include denials; Unicode bytes and end-to-end timing are measured separately', () => {
  const original = data()
  const value = answerMetrics(
    {
      ...original,
      traces: [trace()],
      results: [
        result({
          retrieval: [
            { operation: 'zoom', denied: false, text: '猫' },
            { operation: 'archive_search', denied: false, text: 'ab' },
            { operation: 'archive_read', denied: true, text: 'denied' },
          ],
          timing: { episodeMs: 230, buildMs: 100, answerMs: 120 },
        }),
      ],
    },
    'one.base',
  )
  expect(value).toMatchObject({
    outcome: 'fail',
    apiAttempts: 1,
    toolCalls: 3,
    allowedToolCalls: 2,
    deniedToolCalls: 1,
    returnedBytes: 5,
    toolCallsByName: { zoom: 1, archive_search: 1, archive_read: 1 },
    apiLatencyMs: 100,
    completeApiLatencyMs: 100,
    answerMs: 120,
    buildMs: 100,
    episodeMs: 230,
    spend: 0.000032,
  })
})

test('coverage includes failures and unstarted answers without claiming zero tool/time/correct-answer costs', () => {
  const original = data()
  const run = {
    ...original,
    results: [result({ status: 'failed', timing: { episodeMs: 500 } })],
    traces: [trace({ status: 0, unknownUsage: true, latencyMs: undefined })],
  }
  const arm = efficiency(run).base
  expect(arm).toMatchObject({
    plannedAnswers: 2,
    completedAnswers: 0,
    runtimeFailures: 1,
    unstartedAnswers: 1,
    unfinishedAnswers: 0,
    reviewedAnswers: 0,
    correctAnswers: 0,
    apiAttempts: 1,
    unsettledApiAttempts: 1,
    chargedInputTokens: 10,
    apiLatencyMs: null,
    toolCalls: { total: null, covered: 0 },
    episodeMs: { total: 500, covered: 1 },
    answerMs: { total: null, covered: 0 },
    chargedInputPerCorrect: null,
    chargedOutputPerCorrect: null,
    spendPerCorrect: null,
  })
  const html = renderReport(run)
  expect(html).toContain('unstarted')
  expect(html).toContain('runtime failure')
  expect(html).toContain('API attempts (retries)')
  expect(html).toContain('unmeasured')
  expect(episodes(original.resolved.manifest, original.resolved.scenarios)).toHaveLength(2)
})

test('totals retain failed work when dividing by reviewed correct answers', () => {
  const original = data()
  const run = {
    ...original,
    resolved: {
      ...original.resolved,
      manifest: { ...original.resolved.manifest, corpus: { path: 'private', sha256: '' } },
    },
    results: [
      result({ score: { ...failedScore, correct: true }, reviewStatus: 'pending' }),
      result({ id: 'two.base', status: 'failed' }),
    ],
    traces: [trace(), trace({ attempt: 2, scope: 'metrics-run.two.base', input: 20 })],
  }
  expect(efficiency(run).base?.correctAnswers).toBe(0)
  expect(efficiency(run).base?.spendPerCorrect).toBeNull()
  const scored = {
    ...run,
    results: run.results.map((item) =>
      item.id === 'one.base' ? { ...item, reviewStatus: 'reviewed' as const } : item,
    ),
  }
  expect(efficiency(scored).base).toMatchObject({
    correctAnswers: 1,
    chargedInputPerCorrect: 30,
    apiAttempts: 2,
    runtimeFailures: 1,
  })
})
