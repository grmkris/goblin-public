import { episodes } from './plan.ts'
import type { EpisodeResult, RunData, Trace } from './results.ts'

const sum = (items: readonly number[]): number => items.reduce((total, value) => total + value, 0)
const observed = (items: readonly (number | undefined | null)[]) => {
  const values = items.filter((value): value is number => value !== undefined && value !== null)
  return { total: values.length === 0 ? null : sum(values), covered: values.length }
}
const outcome = (result: EpisodeResult | undefined, attempts: number, real: boolean): string => {
  if (result === undefined) return attempts === 0 ? 'unstarted' : 'unfinished'
  if (result.status === 'failed') return 'runtime failure'
  if (real ? result.reviewStatus !== 'reviewed' : result.reviewStatus === 'pending') return 'review pending'
  return result.score.correct ? 'pass' : 'fail'
}
const scoped = (data: RunData, ids: readonly string[]): Trace[] => {
  const scopes = new Set(ids.map((id) => `${data.resolved.runId}.${id}`))
  return [
    ...new Map(
      data.traces
        .filter((trace) => trace.phase === 'answer' && scopes.has(trace.scope))
        .map((trace) => [trace.attempt, trace]),
    ).values(),
  ]
}

function tokenMetrics(traces: readonly Trace[]) {
  const reported = traces.filter((trace) => !trace.unknownUsage)
  return {
    unknownUsageApiAttempts: traces.length - reported.length,
    chargedInputTokens: sum(traces.map((trace) => trace.input)),
    chargedOutputTokens: sum(traces.map((trace) => trace.output)),
    reportedInputTokens: sum(reported.map((trace) => trace.input)),
    reportedOutputTokens: sum(reported.map((trace) => trace.output)),
  }
}
function requestMetrics(data: RunData, traces: readonly Trace[]) {
  const latency = observed(traces.map((trace) => trace.latencyMs))
  const prices = traces.map((trace) => {
    const rate = data.resolved.manifest.rates.find((item) => item.model === trace.model)
    return rate === undefined || trace.unknownUsage
      ? undefined
      : (trace.input * rate.inputPerMillion + trace.output * rate.outputPerMillion) / 1_000_000
  })
  const spend = observed(prices)
  return {
    apiAttempts: traces.length,
    apiRetries: traces.filter((trace) => (trace.retryIndex ?? 0) > 0).length,
    retryCoverage: traces.filter((trace) => trace.retryIndex !== undefined).length,
    successfulApiAttempts: traces.filter((trace) => trace.status >= 200 && trace.status < 300).length,
    failedApiAttempts: traces.filter((trace) => trace.status !== 0 && (trace.status < 200 || trace.status >= 300))
      .length,
    unsettledApiAttempts: traces.filter((trace) => trace.status === 0).length,
    ...tokenMetrics(traces),
    apiLatencyMs: latency.total,
    apiLatencyCoverage: latency.covered,
    completeApiLatencyMs: latency.covered === traces.length ? latency.total : null,
    reasoning: observed(traces.map((trace) => trace.reasoningTokens)),
    cacheRead: observed(traces.map((trace) => trace.cacheReadTokens)),
    cacheWrite: observed(traces.map((trace) => trace.cacheWriteTokens)),
    spend: spend.covered === traces.length ? spend.total : null,
    pricedApiAttempts: spend.covered,
  }
}

function answerCoverage(rows: readonly ReturnType<typeof answerMetrics>[]) {
  return {
    plannedAnswers: rows.length,
    completedAnswers: rows.filter((row) => ['pass', 'fail', 'review pending'].includes(row.outcome)).length,
    runtimeFailures: rows.filter((row) => row.outcome === 'runtime failure').length,
    unstartedAnswers: rows.filter((row) => row.outcome === 'unstarted').length,
    unfinishedAnswers: rows.filter((row) => row.outcome === 'unfinished').length,
    reviewedAnswers: rows.filter((row) => ['pass', 'fail'].includes(row.outcome)).length,
    correctAnswers: rows.filter((row) => row.outcome === 'pass').length,
  }
}

function toolMetrics(result: EpisodeResult | undefined) {
  const calls = result?.retrieval
  const allowed = calls?.filter((call) => !call.denied)
  return {
    toolCalls: calls?.length ?? null,
    allowedToolCalls: allowed?.length ?? null,
    deniedToolCalls: calls?.filter((call) => call.denied).length ?? null,
    returnedBytes:
      allowed === undefined ? null : sum(allowed.map((call) => new TextEncoder().encode(call.text).length)),
    toolCallsByName: Object.fromEntries(
      ['zoom', 'archive_search', 'archive_read'].map((name) => [
        name,
        calls?.filter((call) => call.operation === name).length ?? null,
      ]),
    ),
  }
}

/** API attempts are distinct from tool calls; absent measurements remain unknown. */
export function answerMetrics(data: RunData, id: string) {
  const traces = scoped(data, [id])
  const result = data.results.find((item) => item.id === id)
  return {
    id,
    outcome: outcome(result, traces.length, data.resolved.manifest.corpus !== undefined),
    ...requestMetrics(data, traces),
    ...toolMetrics(result),
    episodeMs: result?.timing?.episodeMs ?? null,
    buildMs: result?.timing?.buildMs ?? null,
    answerMs: result?.timing?.answerMs ?? null,
  }
}

/** Totals include failed and unfinished work, never just successful answers. Shared builds stay separate. */
export function efficiency(data: RunData) {
  const planned = episodes(data.resolved.manifest, data.resolved.scenarios)
  return Object.fromEntries(
    data.resolved.manifest.variants.map((variant) => {
      const arm = planned.filter((episode) => episode.variant.id === variant.id)
      const rows = arm.map((episode) => ({
        cutoff: episode.probe.cutoff,
        category: episode.probe.category,
        ...answerMetrics(data, episode.id),
      }))
      const requests = requestMetrics(
        data,
        scoped(
          data,
          arm.map((episode) => episode.id),
        ),
      )
      const coverage = answerCoverage(rows)
      const correct = coverage.correctAnswers
      return [
        variant.id,
        {
          ...coverage,
          ...requests,
          toolCalls: observed(rows.map((row) => row.toolCalls)),
          allowedToolCalls: observed(rows.map((row) => row.allowedToolCalls)),
          deniedToolCalls: observed(rows.map((row) => row.deniedToolCalls)),
          returnedBytes: observed(rows.map((row) => row.returnedBytes)),
          episodeMs: observed(rows.map((row) => row.episodeMs)),
          answerMs: observed(rows.map((row) => row.answerMs)),
          chargedInputPerCorrect: correct === 0 ? null : requests.chargedInputTokens / correct,
          chargedOutputPerCorrect: correct === 0 ? null : requests.chargedOutputTokens / correct,
          spendPerCorrect: correct === 0 || requests.spend === null ? null : requests.spend / correct,
          answers: rows,
        },
      ]
    }),
  )
}
