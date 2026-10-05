import { Schema } from 'effect'
import { episodes } from './plan.ts'
import { exceededReservation, phaseLimits, type AllowanceLimits, type Totals } from './budget.ts'
import type { RunData, Trace } from './results.ts'
import type { Manifest } from './schema.ts'

const TotalsSchema = Schema.Struct({ requests: Schema.Number, input: Schema.Number, output: Schema.Number })
export const StageReceipt = Schema.Struct({
  runId: Schema.String,
  sourceHash: Schema.String,
  corpusHash: Schema.String,
  cutoff: Schema.Int,
  at: Schema.String,
  passed: Schema.Boolean,
  reasons: Schema.Array(Schema.String),
  plannedAnswers: Schema.Int,
  completedAnswers: Schema.Int,
  pendingAnswers: Schema.Array(Schema.String),
  remaining: TotalsSchema,
  remainingPhases: Schema.Record(Schema.String, TotalsSchema),
})
export type StageReceipt = typeof StageReceipt.Type
type Stage = NonNullable<Manifest['allowance']['stages']>[number]
const attempts = (data: RunData): Trace[] => [...new Map(data.traces.map((trace) => [trace.attempt, trace])).values()]
const remaining = (limits: AllowanceLimits, traces: readonly Trace[]): Totals => ({
  requests: limits.maxRequests - traces.length,
  input: limits.maxInputTokens - traces.reduce((n, trace) => n + trace.input, 0),
  output: limits.maxOutputTokens - traces.reduce((n, trace) => n + trace.output, 0),
})
const fits = (left: Totals, limits: AllowanceLimits): boolean =>
  left.requests >= limits.maxRequests && left.input >= limits.maxInputTokens && left.output >= limits.maxOutputTokens
const negative = (left: Totals): boolean => left.requests < 0 || left.input < 0 || left.output < 0
function phaseRemaining(data: RunData, traces: readonly Trace[]) {
  return {
    preflight: remaining(
      phaseLimits(data.resolved.manifest, 'preflight'),
      traces.filter((trace) => trace.phase === 'preflight'),
    ),
    build: remaining(
      phaseLimits(data.resolved.manifest, 'build'),
      traces.filter((trace) => trace.phase === 'build'),
    ),
    answer: remaining(
      phaseLimits(data.resolved.manifest, 'answer'),
      traces.filter((trace) => trace.phase === 'answer'),
    ),
  }
}
function usageReasons(data: RunData, traces: readonly Trace[]): string[] {
  const reasons: string[] = []
  if (traces.some((trace) => trace.unknownUsage || trace.status === 0))
    reasons.push('Unknown usage or unsettled provider attempts')
  if (traces.some(exceededReservation)) reasons.push('Provider reservation breach')
  const counts = Map.groupBy(
    traces.filter((trace) => trace.phase === 'answer'),
    (trace) => trace.scope,
  )
  if ([...counts.values()].some((group) => group.length > (data.resolved.manifest.allowance.maxRequestsPerAnswer ?? 8)))
    reasons.push('Per-answer request ceiling exceeded')
  if (
    [remaining(data.resolved.manifest.allowance, traces), ...Object.values(phaseRemaining(data, traces))].some(negative)
  )
    reasons.push('Run or phase allowance exceeded')
  reasons.push(...stageUsageReasons(data, traces))
  return reasons
}
function stageUsageReasons(data: RunData, traces: readonly Trace[]): string[] {
  const reasons: string[] = []
  const stages = data.resolved.manifest.allowance.stages
  if (stages === undefined) return reasons
  if (traces.some((trace) => trace.phase !== 'preflight' && !stages.some((stage) => stage.cutoff === trace.stage)))
    reasons.push('Missing or invalid stage label')
  for (const stage of data.resolved.manifest.allowance.stages ?? []) {
    const used = traces.filter((trace) => trace.stage === stage.cutoff)
    if (
      negative(
        remaining(
          stage.build,
          used.filter((trace) => trace.phase === 'build'),
        ),
      ) ||
      negative(
        remaining(
          stage.answer,
          used.filter((trace) => trace.phase === 'answer'),
        ),
      )
    )
      reasons.push('Stage phase allowance exceeded')
  }
  return reasons
}
/** Operational coverage is independent of answer quality or review scores. */
export function stageGate(data: RunData, cutoff: number) {
  const planned = episodes(data.resolved.manifest, data.resolved.scenarios).filter(
    (episode) => episode.probe.cutoff <= cutoff,
  )
  const traces = attempts(data)
  const completedAnswers = planned.filter(
    (episode) => data.results.find((result) => result.id === episode.id)?.status === 'completed',
  ).length
  const reasons = usageReasons(data, traces)
  if (completedAnswers !== planned.length || planned.length === 0) reasons.push('Every selected answer must complete')
  return {
    passed: reasons.length === 0,
    reasons,
    plannedAnswers: planned.length,
    completedAnswers,
    remaining: remaining(data.resolved.manifest.allowance, traces),
    remainingPhases: phaseRemaining(data, traces),
    pendingAnswers: episodes(data.resolved.manifest, data.resolved.scenarios)
      .filter((episode) => !data.results.some((result) => result.id === episode.id))
      .map((episode) => episode.id),
  }
}
function receiptReasons(
  data: RunData,
  receipts: readonly StageReceipt[],
  cutoff: number,
  earlier: Stage | undefined,
): string[] {
  const reasons: string[] = []
  if (
    receipts.some(
      (receipt) =>
        receipt.runId !== data.resolved.runId ||
        receipt.sourceHash !== data.resolved.sourceHash ||
        receipt.corpusHash !== data.resolved.corpusHash,
    )
  )
    reasons.push('Stage receipt identity mismatch')
  if (receipts.some((receipt) => receipt.cutoff > cutoff)) reasons.push('Stage cannot move backwards')
  if (receipts.some((receipt) => receipt.cutoff === cutoff && !receipt.passed))
    reasons.push('Failed stage is preserved; start a fresh named trial')
  if (
    earlier !== undefined &&
    (!receipts.findLast((receipt) => receipt.cutoff === earlier.cutoff)?.passed ||
      !stageGate(data, earlier.cutoff).passed)
  )
    reasons.push('Previous stage must pass its durable operational gate')
  return reasons
}
function envelopeReasons(data: RunData, stage: Stage, traces: readonly Trace[]): string[] {
  const reasons: string[] = []
  const stageUsed = traces.filter((trace) => trace.stage === stage.cutoff)
  const build = remaining(
    stage.build,
    stageUsed.filter((trace) => trace.phase === 'build'),
  )
  const answer = remaining(
    stage.answer,
    stageUsed.filter((trace) => trace.phase === 'answer'),
  )
  const total = {
    maxRequests: build.requests + answer.requests,
    maxInputTokens: build.input + answer.input,
    maxOutputTokens: build.output + answer.output,
  }
  if (!fits(remaining(data.resolved.manifest.allowance, traces), total))
    reasons.push('Remaining run allowance cannot admit the declared stage envelope')
  const left = phaseRemaining(data, traces)
  if (!fits(left.build, { maxRequests: build.requests, maxInputTokens: build.input, maxOutputTokens: build.output }))
    reasons.push('Remaining build allowance cannot admit stage')
  if (
    !fits(left.answer, { maxRequests: answer.requests, maxInputTokens: answer.input, maxOutputTokens: answer.output })
  )
    reasons.push('Remaining answer allowance cannot admit stage')
  return reasons
}
/** Later stages require a durable passed gate and room for the entire remaining declared envelope. */
export function stageAdmission(data: RunData, receipts: readonly StageReceipt[], requested: number | undefined) {
  const stages = data.resolved.manifest.allowance.stages
  const empty: string[] = []
  if (stages === undefined) return { cutoff: requested, reasons: empty }
  const cutoff = requested ?? stages[0]?.cutoff
  const index = stages.findIndex((stage) => stage.cutoff === cutoff)
  const stage = stages[index]
  if (stage === undefined) return { cutoff, reasons: ['Select a configured --until-cutoff'] }
  const traces = attempts(data)
  const reasons = [...receiptReasons(data, receipts, stage.cutoff, stages[index - 1]), ...usageReasons(data, traces)]
  const planned = episodes(data.resolved.manifest, data.resolved.scenarios)
  if (
    planned.some(
      (episode) =>
        !data.results.some((result) => result.id === episode.id) &&
        traces.some((trace) => trace.scope === `${data.resolved.runId}.${episode.id}`),
    )
  )
    reasons.push('Unfinished answer evidence is preserved; start a fresh named trial')
  if (!receipts.some((receipt) => receipt.cutoff === stage.cutoff))
    reasons.push(...envelopeReasons(data, stage, traces))
  return { cutoff: stage.cutoff, reasons }
}
