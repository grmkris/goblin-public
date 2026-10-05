import { artifactIdentity } from '../scripts/artifact.ts'
import { episodes } from './plan.ts'
import { buildPolicy } from './schema.ts'
import { efficiency } from './metrics.ts'
import { semanticSummary } from './semantic.ts'
import type { RunData, Trace } from './results.ts'

const unique = (traces: readonly Trace[]) => [...new Map(traces.map((trace) => [trace.attempt, trace])).values()]
const ratio = (value: number, count: number) => (count === 0 ? null : value / count)
function sumField(traces: readonly Trace[], field: 'input' | 'output') {
  return traces.reduce((n, trace) => n + trace[field], 0)
}
function knownSum(traces: readonly Trace[], field: 'input' | 'output') {
  return sumField(
    traces.filter((trace) => !trace.unknownUsage),
    field,
  )
}
function stageRows(calls: readonly Trace[]) {
  return [...Map.groupBy(calls, (trace) => trace.stage)].map(([cutoff, used]) => ({
    cutoff: cutoff ?? null,
    attempts: used.length,
    input: sumField(used, 'input'),
    output: sumField(used, 'output'),
  }))
}
function memoryRow(
  data: RunData,
  group: readonly import('./plan.ts').Episode[],
  traces: readonly Trace[],
  scope: string,
) {
  const calls = traces.filter((trace) => trace.scope === scope)
  const input = sumField(calls, 'input'),
    output = sumField(calls, 'output')
  const completed = group.filter(
    (episode) => data.results.find((result) => result.id === episode.id)?.status === 'completed',
  ).length
  const first = group[0]
  const memory = first === undefined ? 'unknown' : buildPolicy(first.variant.policy)
  const arms = [...new Set(group.map((item) => item.variant.id))]
  const timed =
    calls.length > 0 && calls.every((trace) => trace.latencyMs !== undefined)
      ? calls.reduce((n, trace) => n + (trace.latencyMs ?? 0), 0)
      : null
  return {
    scope,
    memory,
    arms,
    plannedAnswers: group.length,
    completedAnswers: completed,
    apiAttempts: calls.length,
    chargedInput: input,
    chargedOutput: output,
    reportedInput: knownSum(calls, 'input'),
    reportedOutput: knownSum(calls, 'output'),
    unknownUsageAttempts: calls.filter((trace) => trace.unknownUsage).length,
    apiMs: timed,
    amortizedPerPlanned: {
      input: ratio(input, group.length),
      output: ratio(output, group.length),
      attempts: ratio(calls.length, group.length),
    },
    amortizedPerCompleted: {
      input: ratio(input, completed),
      output: ratio(output, completed),
      attempts: ratio(calls.length, completed),
    },
    stages: stageRows(calls),
  }
}
/** Each shared memory is charged once across its search pair; denominators include both arms. */
export function construction(data: RunData) {
  const planned = episodes(data.resolved.manifest, data.resolved.scenarios)
  const roots = Map.groupBy(planned, (episode) =>
    artifactIdentity(data.resolved, episode.probe.scenarioId, episode.variant),
  )
  const traces = unique(data.traces).filter((trace) => trace.phase === 'build')
  const memories = [...roots].map(([scope, group]) => memoryRow(data, group, traces, scope))
  return {
    memories,
    unassignedBuildAttempts: traces.filter((trace) => !roots.has(trace.scope)).length,
    note: 'Recorded construction only. Zero calls may mean warm reuse; a fresh buildTrial is required for cold construction. Each search pair shares the planned and completed denominators.',
  }
}
export function semanticEfficiency(data: RunData) {
  const readers = efficiency(data)
  return Object.fromEntries(
    Object.entries(semanticSummary(data)).map(([variant, scores]) => {
      const arm = readers[variant]
      const tokens = arm === undefined ? 0 : arm.chargedInputTokens + arm.chargedOutputTokens
      return [
        variant,
        {
          resolvedAnswers: scores.resolved,
          semanticPasses: scores.semanticPasses,
          passesPerMillionChargedReaderTokens:
            scores.resolved === 0 || tokens === 0 ? null : (scores.semanticPasses * 1000000) / tokens,
          passesPerReaderApiAttempt: scores.resolved === 0 ? null : ratio(scores.semanticPasses, arm?.apiAttempts ?? 0),
          chargedReaderTokensPerPass: ratio(tokens, scores.semanticPasses),
          estimatedReaderSpendPerPass:
            arm?.spend === null || arm?.spend === undefined ? null : ratio(arm.spend, scores.semanticPasses),
          note: 'Human-resolved passes; unresolved answers contribute spend but no pass. Shared construction is reported separately.',
        },
      ]
    }),
  )
}
