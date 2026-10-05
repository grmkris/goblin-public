import { escape, table } from './html.ts'
import { recallTables } from './recall-report.ts'
import type { RunData, EpisodeResult, Trace } from './results.ts'
import { sameTransport } from './transport.ts'
import { episodes } from './plan.ts'
import { paired } from './paired.ts'
import { factorial } from './factorial.ts'
import { semanticSummary } from './semantic.ts'
import { construction, semanticEfficiency } from './construction.ts'
import { exceededReservation } from './budget.ts'
import { efficiency } from './metrics.ts'

const grouped = (data: RunData): Map<string, EpisodeResult[]> => Map.groupBy(data.results, (result) => result.variant)
const average = (results: readonly EpisodeResult[]): number =>
  results.length === 0 ? 0 : results.filter((result) => result.score.correct).length / results.length
const categoryScores = (results: readonly EpisodeResult[]) =>
  Object.fromEntries(
    [...Map.groupBy(results, (result) => result.category)].map(([category, items]) => [category, average(items)]),
  )
const probeIds = (data: RunData) =>
  data.results.map((result) => result.id.slice(0, -result.variant.length - 1)).toSorted()
const attemptsOf = (data: RunData) => [...new Map(data.traces.map((trace) => [trace.attempt, trace])).values()]
const tokens = (traces: readonly Trace[]) => ({
  input: traces.reduce((n, trace) => n + trace.input, 0),
  output: traces.reduce((n, trace) => n + trace.output, 0),
})

export function summary(data: RunData) {
  return Object.fromEntries(
    [...grouped(data)].map(([variant, results]) => {
      const scored = results.filter(
        (result) =>
          result.status === 'completed' &&
          (data.resolved.manifest.corpus === undefined
            ? result.reviewStatus !== 'pending'
            : result.reviewStatus === 'reviewed'),
      )
      return [
        variant,
        {
          answers: results.length,
          correct: scored.filter((result) => result.score.correct).length,
          accuracy: scored.length === 0 ? null : average(scored),
          scoredAnswers: scored.length,
          completedAnswers: results.filter((result) => result.status === 'completed').length,
          runtimeFailures: results.filter((result) => result.status === 'failed').length,
          categories: categoryScores(scored),
          failures:
            results.filter((result) => result.status === 'failed').length +
            scored.filter((result) => !result.score.correct).length,
          pendingReviews: results.filter((result) => result.reviewStatus === 'pending').length,
        },
      ]
    }),
  )
}
/** The final record settles each attempt; reservations without reported usage remain charged. */
export function accounting(data: RunData) {
  const attempts = attemptsOf(data)
  const reported = attempts.filter((trace) => !trace.unknownUsage)
  return {
    requests: attempts.length,
    successfulRequests: attempts.filter((trace) => trace.status >= 200 && trace.status < 300).length,
    failedRequests: attempts.filter((trace) => trace.status !== 0 && (trace.status < 200 || trace.status >= 300))
      .length,
    unsettledRequests: attempts.filter((trace) => trace.status === 0).length,
    unknownUsageRequests: attempts.length - reported.length,
    chargedTokens: tokens(attempts),
    reportedTokens: tokens(reported),
  }
}
/** Shared construction and preflight costs remain separate from each reader arm. */
export function phaseAccounting(data: RunData) {
  const planned = episodes(data.resolved.manifest, data.resolved.scenarios)
  const groups = Map.groupBy(attemptsOf(data), (trace) =>
    trace.phase === 'answer'
      ? (planned.find((episode) => trace.scope === `${data.resolved.runId}.${episode.id}`)?.variant.id ??
        'unassigned-answer')
      : trace.phase,
  )
  return Object.fromEntries(
    [...groups].map(([phase, traces]) => [
      phase,
      {
        ...accounting({ ...data, traces }),
        reservationBreaches: traces.filter(exceededReservation).length,
        latencyMs: traces.reduce((n, trace) => n + (trace.latencyMs ?? 0), 0),
        latencyCoverage: traces.filter((trace) => trace.latencyMs !== undefined).length,
        details: Object.fromEntries(
          ['reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens'].map((field) => {
            const values = traces.flatMap((trace) =>
              field === 'reasoningTokens'
                ? (trace.reasoningTokens ?? [])
                : field === 'cacheReadTokens'
                  ? (trace.cacheReadTokens ?? [])
                  : (trace.cacheWriteTokens ?? []),
            )
            return [
              field,
              {
                tokens: values.length === 0 ? null : values.reduce((n, value) => n + value, 0),
                coveredRequests: values.length,
              },
            ]
          }),
        ),
      },
    ]),
  )
}
export function cost(data: RunData) {
  const attempts = attemptsOf(data)
  let spend = 0
  for (const trace of attempts) {
    const rate = data.resolved.manifest.rates.find((item) => item.model === trace.model)
    if (rate === undefined || trace.unknownUsage)
      return { runSpend: null, reason: 'Missing dated model prices or provider usage', requests: attempts.length }
    spend += (trace.input * rate.inputPerMillion + trace.output * rate.outputPerMillion) / 1_000_000
  }
  return {
    runSpend: attempts.length === 0 ? null : spend,
    reason: 'Recorded provider calls only; cold build costs require a fresh buildTrial',
    requests: attempts.length,
  }
}
export function compare(candidate: RunData, incumbent: RunData) {
  const compatible =
    candidate.resolved.corpusHash === incumbent.resolved.corpusHash &&
    JSON.stringify(candidate.resolved.manifest.scenarioIds) ===
      JSON.stringify(incumbent.resolved.manifest.scenarioIds) &&
    JSON.stringify(candidate.resolved.manifest.pressure) === JSON.stringify(incumbent.resolved.manifest.pressure) &&
    JSON.stringify(candidate.resolved.manifest.retrieval) === JSON.stringify(incumbent.resolved.manifest.retrieval) &&
    candidate.resolved.manifest.profile === incumbent.resolved.manifest.profile &&
    sameTransport(candidate.resolved.manifest, incumbent.resolved.manifest)
  return {
    compatible,
    candidate: candidate.resolved.runId,
    incumbent: incumbent.resolved.runId,
    candidateScores: summary(candidate),
    incumbentScores: summary(incumbent),
    candidateCost: cost(candidate),
    incumbentCost: cost(incumbent),
  }
}
function complete(data: RunData): boolean {
  const expected = episodes(data.resolved.manifest, data.resolved.scenarios)
    .map((episode) => episode.id)
    .toSorted()
  const actual = data.results.map((result) => result.id).toSorted()
  return (
    JSON.stringify(expected) === JSON.stringify(actual) && data.results.every((result) => result.status === 'completed')
  )
}
const pendingReviewReasons = (data: RunData): string[] =>
  data.results.some((result) => result.reviewStatus === 'pending') ? ['Semantic reviews remain pending'] : []
export function promotion(candidate: RunData, incumbent: RunData) {
  const reasons = pendingReviewReasons(candidate)
  if (candidate.resolved.mode !== 'live' || incumbent.resolved.mode !== 'live')
    reasons.push('Fake provider results cannot be promoted')
  if (candidate.resolved.manifest.split !== 'held-out' || incumbent.resolved.manifest.split !== 'held-out')
    reasons.push('Both runs must use held-out families')
  if (candidate.resolved.manifest.variants.length !== 1 || incumbent.resolved.manifest.variants.length !== 1)
    reasons.push('Select one candidate and one incumbent configuration per manifest')
  if (
    !compare(candidate, incumbent).compatible ||
    JSON.stringify(probeIds(candidate)) !== JSON.stringify(probeIds(incumbent))
  )
    reasons.push('Runs do not contain matching probes and budgets')
  if (!complete(candidate) || !complete(incumbent)) reasons.push('Every planned episode must have completed')
  if (average(candidate.results) < 0.9) reasons.push('Supported answer accuracy is below 90 percent')
  const next = categoryScores(candidate.results)
  const prior = categoryScores(incumbent.results)
  if (Object.entries(prior).some(([category, accuracy]) => (next[category] ?? -1) < accuracy))
    reasons.push('A category regressed')
  if (
    candidate.results.some(
      (result) =>
        result.futureLeakage ||
        result.unauthorizedReads ||
        result.forbiddenEndorsement ||
        result.malformed ||
        !result.score.evidenceValid ||
        result.score.unsupported,
    )
  )
    reasons.push('Safety or citation gate failed')
  return {
    eligible: reasons.length === 0,
    reasons,
    candidate: candidate.resolved.runId,
    incumbent: incumbent.resolved.runId,
    cost: cost(candidate),
  }
}
const seconds = (value: number | null): string => (value === null ? 'unmeasured' : `${(value / 1000).toFixed(2)} s`)
const display = (value: number | null): string => (value === null ? 'unknown' : value.toLocaleString('en-US'))
type Arms = ReturnType<typeof efficiency>
function readerTable(arms: Arms): string {
  return table(
    'Reader efficiency by variant',
    [
      'variant',
      'completed / planned',
      'strict passes / scored',
      'API attempts (retries)',
      'tool calls (denied)',
      'tool coverage',
      'input tokens',
      'completion tokens',
      'API time',
      'API timing coverage',
      'answer time coverage',
      'estimated spend',
    ],
    Object.entries(arms).map(([variant, arm]) => [
      variant,
      `${arm.completedAnswers} / ${arm.plannedAnswers}`,
      `${arm.correctAnswers} / ${arm.reviewedAnswers}`,
      `${arm.apiAttempts} (${arm.apiRetries})`,
      `${display(arm.toolCalls.total)} (${display(arm.deniedToolCalls.total)})`,
      `${arm.toolCalls.covered} / ${arm.plannedAnswers}`,
      display(arm.chargedInputTokens),
      display(arm.chargedOutputTokens),
      seconds(arm.apiLatencyMs),
      `${arm.apiLatencyCoverage} / ${arm.apiAttempts}`,
      `${arm.answerMs.covered} / ${arm.plannedAnswers}`,
      arm.spend === null ? 'unknown' : arm.spend.toFixed(6),
    ]),
  )
}
function answerTable(arms: Arms): string {
  return table(
    'Every planned answer, including unstarted and failed work',
    [
      'variant',
      'cutoff',
      'question category',
      'outcome',
      'API attempts (retries)',
      'tool calls (denied)',
      'input tokens',
      'completion tokens',
      'API time',
      'API timing coverage',
      'answer time',
      'checkpoint + answer time',
    ],
    Object.entries(arms).flatMap(([variant, arm]) =>
      arm.answers.map((row) => [
        variant,
        String(row.cutoff),
        row.category,
        row.outcome,
        `${row.apiAttempts} (${row.apiRetries})`,
        `${display(row.toolCalls)} (${display(row.deniedToolCalls)})`,
        display(row.chargedInputTokens),
        display(row.chargedOutputTokens),
        seconds(row.apiLatencyMs),
        `${row.apiLatencyCoverage} / ${row.apiAttempts}`,
        seconds(row.answerMs),
        seconds(row.episodeMs),
      ]),
    ),
  )
}
function sharedTable(data: RunData): string {
  return table(
    'Preflight and shared memory construction (excluded from reader totals)',
    [
      'phase',
      'API attempts',
      'charged input',
      'charged completion',
      'reported input',
      'reported completion',
      'unknown usage attempts',
      'API time',
      'API timing coverage',
    ],
    Object.entries(phaseAccounting(data))
      .filter(([phase]) => phase === 'preflight' || phase === 'build' || phase === 'unassigned-answer')
      .map(([phase, metrics]) => [
        phase,
        String(metrics.requests),
        display(metrics.chargedTokens.input),
        display(metrics.chargedTokens.output),
        display(metrics.reportedTokens.input),
        display(metrics.reportedTokens.output),
        String(metrics.unknownUsageRequests),
        metrics.latencyCoverage === 0 ? 'unmeasured' : seconds(metrics.latencyMs),
        `${metrics.latencyCoverage} / ${metrics.requests}`,
      ]),
  )
}
function renderEfficiency(data: RunData): string {
  const arms = efficiency(data)
  return `${readerTable(arms)}${answerTable(arms)}${sharedTable(data)}<p>API time sums recorded response durations; coverage counts measured attempts. Answer time includes retrieval and model turns after the checkpoint is ready. Checkpoint + answer time also includes checkpoint readiness and evaluation. Older runs have no coordinator timing. Unknown retrieval logs and prices remain unknown. Completion tokens include reasoning; reasoning/cache details and retries have measurement coverage in JSON. These totals include failures and unfinished work. Cost per correct answer is unknown when no answer passes. TTFT is unmeasured.</p>`
}
/** Shared JSON payload keeps readable and machine reports on the same metrics. */
export function reportData(data: RunData) {
  return {
    plannedAnswers: episodes(data.resolved.manifest, data.resolved.scenarios).length,
    scores: summary(data),
    accounting: accounting(data),
    phases: phaseAccounting(data),
    efficiency: efficiency(data),
    paired: paired(data),
    factorial: factorial(data),
    semantic: semanticSummary(data),
    stages: data.stageReceipts ?? [],
    construction: construction(data),
    semanticEfficiency: semanticEfficiency(data),
    cost: cost(data),
  }
}
export function renderReport(data: RunData): string {
  const rows = data.results
    .map(
      (result) =>
        `<tr><td>${escape(result.variant)}</td><td>${escape(result.id)}</td><td>${result.status === 'failed' ? 'runtime failure' : result.reviewStatus === 'pending' ? 'review pending' : result.score.correct ? 'pass' : 'fail'}</td><td><details><summary>inspect</summary><pre>${escape(JSON.stringify(result, null, 2))}</pre><a href="${result.status === 'failed' ? 'failures.jsonl' : `traces/${encodeURIComponent(result.id)}.json`}">private ${result.status === 'failed' ? 'failure ledger' : 'episode trace'}</a></details></td></tr>`,
    )
    .join('')
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Memory bench ${escape(data.resolved.runId)}</title><style>body{font:14px system-ui;margin:2rem;background:#111;color:#eee}table{border-collapse:collapse;width:100%;margin:1rem 0}caption{text-align:left;font-weight:bold;margin:.5rem 0}td,th{border:1px solid #444;padding:.4rem}details{max-width:80rem}pre{white-space:pre-wrap}a{color:#8bd}.scroll{overflow-x:auto}</style><h1>${escape(data.resolved.runId)}</h1><p>${escape(data.resolved.mode)} provider · source ${escape(data.resolved.sourceHash)} · corpus ${escape(data.resolved.corpusHash)}</p><p>Accuracy covers completed, scored answers; real answers require semantic review. Inspect completion and review coverage before comparing variants. Charged tokens include retained reservations when provider usage is unknown.</p>${recallTables(data)}${renderEfficiency(data)}<details><summary>Accounting and paired diagnostic details</summary><pre>${escape(JSON.stringify(reportData(data), null, 2))}</pre></details><table><thead><tr><th>variant</th><th>episode</th><th>result</th><th>trace</th></tr></thead><tbody>${rows}</tbody></table>`
}
