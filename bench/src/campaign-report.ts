import type { Episode } from './plan.ts'
import type { Campaign, CampaignStage } from './campaign.ts'
import { campaignTotals, stageEpisodes, settledAttempts } from './campaign.ts'
import type { Manifest } from './schema.ts'
import type { RunData, Trace, EpisodeResult } from './results.ts'
import type { SemanticVote } from './semantic.ts'
import { semanticOutcome, resolution } from './semantic.ts'
import { answerMetrics } from './metrics.ts'
import { artifactIdentity } from '../scripts/artifact.ts'
import { campaignComparisons, productCriteria } from './campaign-pairs.ts'

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
function renderedContext(traces: readonly Trace[]) {
  return settledAttempts(traces).map((t) => {
    let messages: unknown = null
    try {
      const request: unknown = JSON.parse(t.request)
      if (typeof request === 'object' && request !== null && 'messages' in request) messages = request.messages
    } catch {
      // expected: missing or invalid legacy payloads remain unmeasured
    }
    return {
      attempt: t.attempt,
      messageCount: Array.isArray(messages) ? messages.length : null,
      serializedMessagesBytes: Array.isArray(messages) ? bytes(messages) : null,
      reportedPromptTokens: t.unknownUsage ? null : t.input,
    }
  })
}

const mean = (values: readonly number[]) =>
  values.length === 0 ? null : values.reduce((n, v) => n + v, 0) / values.length
function usage(traces: readonly Trace[]) {
  const unique = settledAttempts(traces)
  return {
    ...campaignTotals(unique),
    reportedInput: unique.filter((t) => !t.unknownUsage).reduce((n, t) => n + t.input, 0),
    reportedOutput: unique.filter((t) => !t.unknownUsage).reduce((n, t) => n + t.output, 0),
    unknownUsage: unique.filter((t) => t.unknownUsage).length,
    retries: unique.filter((t) => (t.retryIndex ?? 0) > 0).length,
    apiMs: unique.every((t) => t.latencyMs !== undefined) ? unique.reduce((n, t) => n + (t.latencyMs ?? 0), 0) : null,
  }
}
function diagnosticPass(result: EpisodeResult | undefined, vote: SemanticVote | undefined) {
  if (vote === undefined) return null
  return (
    result?.status === 'completed' &&
    !result.futureLeakage &&
    !result.unauthorizedReads &&
    !result.forbiddenEndorsement &&
    vote.score.factualCorrect &&
    vote.score.abstentionCorrect &&
    !vote.score.unsupported
  )
}
function supportedSearch(result: EpisodeResult | undefined, vote: SemanticVote | undefined) {
  return (
    vote?.searchSupported === true &&
    result?.deliveries?.some(
      (d) => (d.origin === 'search' || d.origin === 'read') && vote.evidenceIds.includes(d.id),
    ) === true
  )
}
function answerRow(data: RunData, episode: Episode) {
  const result = data.results.find((r) => r.id === episode.id)
  const votes = (data.semanticVotes ?? []).filter((v) => v.episodeId === episode.id)
  const { machine } = resolution(votes)
  const final = semanticOutcome(result, votes)
  const scope = `${data.resolved.runId}.${episode.id}`
  return {
    episodeId: episode.id,
    probeId: episode.probe.id,
    corpus: episode.probe.scenarioId,
    cutoff: episode.probe.cutoff,
    category: episode.probe.category,
    variant: episode.variant.id,
    writer: episode.variant.writer ?? episode.variant.reader,
    reader: episode.variant.reader,
    policy: episode.variant.policy,
    completed: result?.status === 'completed',
    malformed: result?.malformed ?? null,
    futureLeakage: result?.futureLeakage ?? null,
    machinePass: diagnosticPass(result, machine),
    machineUnsupported: machine?.score.unsupported ?? null,
    finalUnsupported: final.final?.score.unsupported ?? null,
    searchSupported: supportedSearch(result, final.final),
    machineSearchSupported: supportedSearch(result, machine),
    finalPass: final.semanticPass,
    finalEvidencePass: final.evidencePass,
    disagreement: final.disagreement,
    readerUsage: usage(data.traces.filter((t) => t.scope === scope)),
    renderedContext: renderedContext(data.traces.filter((t) => t.scope === scope)),
    metrics: result === undefined ? null : answerMetrics(data, episode.id),
  }
}
export type CampaignAnswer = ReturnType<typeof answerRow>
function armReport(
  options: {
    stage: CampaignStage
    index: number
    manifests: readonly Manifest[]
    data: RunData
    planned: readonly Episode[]
    rows: readonly ReturnType<typeof answerRow>[]
  },
  variant: string,
) {
  const { stage, index, manifests, data, planned, rows } = options
  const selected = stageEpisodes(stage, manifests, data.resolved.scenarios ?? []).filter(
    (e) => e.variant.id === variant,
  )
  const answers = rows.filter((r) => selected.some((e) => e.id === r.episodeId))
  const actor =
    selected[0] === undefined
      ? undefined
      : artifactIdentity(data.resolved, selected[0].probe.scenarioId, selected[0].variant)
  const shared = planned.filter(
    (e) =>
      e.probe.cutoff <= stage.cutoff &&
      artifactIdentity(data.resolved, e.probe.scenarioId, e.variant) === actor &&
      data.results.some((r) => r.id === e.id && r.status === 'completed'),
  )
  const construction = usage(
    data.traces.filter((t) => t.scope === actor && t.phase === 'build' && (t.stage ?? 0) <= index + 1),
  )
  const machine = answers.filter((a) => a.machinePass !== null)
  const human = answers.filter((a) => a.finalPass !== null)
  return {
    variant,
    planned: answers.length,
    completed: answers.filter((a) => a.completed).length,
    machineDiagnostic: {
      reviewed: machine.length,
      passRate: mean(machine.map((a) => Number(a.machinePass))),
      unsupported: answers.filter((a) => a.machineUnsupported).length,
    },
    humanResolved: { reviewed: human.length, passRate: mean(human.map((a) => Number(a.finalPass))) },
    meanAnswerMs: mean(
      answers.flatMap((a) =>
        a.metrics?.answerMs === null || a.metrics?.answerMs === undefined ? [] : [a.metrics.answerMs],
      ),
    ),
    readerUsage: usage(data.traces.filter((t) => selected.some((e) => t.scope === `${data.resolved.runId}.${e.id}`))),
    construction,
    amortizedConstructionTokensPerCompletedAnswer:
      shared.length === 0 ? null : (construction.input + construction.output) / shared.length,
    note: 'Construction belongs to one shared writer memory, not independently to each search arm. Amortization uses completed answers only; reader cost is separate.',
  }
}
function checkpointReport(options: Parameters<typeof armReport>[0]) {
  const { stage, index, manifests, data } = options
  return {
    stage: stage.id,
    cutoff: stage.cutoff,
    corpus: stageEpisodes(stage, manifests, data.resolved.scenarios ?? [])[0]?.probe.scenarioId,
    phaseUsage: Object.fromEntries(
      ['build', 'answer', 'judge'].map((phase) => [
        phase,
        usage(data.traces.filter((t) => t.stage === index + 1 && t.phase === phase)),
      ]),
    ),
    arms: stage.variants.map((variant) => armReport(options, variant)),
  }
}
export function campaignReport(campaign: Campaign, manifests: readonly Manifest[], data: RunData) {
  const planned = campaign.stages.flatMap((stage) => stageEpisodes(stage, manifests, data.resolved.scenarios ?? []))
  const rows = planned.map((episode) => answerRow(data, episode))
  const checkpoints = campaign.stages.map((stage, index) =>
    checkpointReport({ stage, index, manifests, data, planned, rows }),
  )
  const comparisons = campaignComparisons(campaign, manifests, rows)
  return {
    campaign: campaign.name,
    runId: data.resolved.runId,
    sourceHash: data.resolved.sourceHash,
    corpusHash: data.resolved.corpusHash,
    total: usage(data.traces),
    phases: Object.fromEntries(
      ['preflight', 'build', 'answer', 'judge'].map((p) => [p, usage(data.traces.filter((t) => t.phase === p))]),
    ),
    coverage: {
      planned: planned.length,
      completed: rows.filter((r) => r.completed).length,
      machineReviewed: rows.filter((r) => r.machinePass !== null).length,
      humanResolved: rows.filter((r) => r.finalPass !== null).length,
    },
    checkpoints,
    comparisons,
    productCriteria: productCriteria(comparisons),
    categories: [...Map.groupBy(rows, (r) => `${r.corpus}.${r.category}.${r.variant}`)].map(([key, group]) => ({
      key,
      planned: group.length,
      completed: group.filter((r) => r.completed).length,
      machinePassRate: mean(group.flatMap((r) => (r.machinePass === null ? [] : [Number(r.machinePass)]))),
      finalPassRate: mean(group.flatMap((r) => (r.finalPass === null ? [] : [Number(r.finalPass)]))),
    })),
    rows,
    productDecision: rows.every((r) => r.finalPass !== null)
      ? 'Inspect paired human-resolved results against preregistered criteria'
      : 'Pending independent human audit; machine scores are diagnostic',
    successCriteria: {
      gainPointsOnBothCorpora: 10,
      maximumCategoryRegressionPoints: 5,
      latencyRatioBelow: 2,
      amortizedCostRatioBelow: 2,
      unsupportedAndLeakageMustNotIncrease: true,
      writerQualityTolerancePoints: 5,
      tie: 'native',
      searchRequiresCitedOriginalDelivery: true,
    },
    dollarCost: null,
    ttftMs: null,
    promotion: false,
    limits:
      'Two genuine histories and five probes per checkpoint provide exploratory evidence. Serialized message bytes measure actual API context; reported prompt tokens include provider overhead and are not a separate rendering tokenizer. Unknown prices prevent a dollar-cost claim; machine review uses audited evidence ranges, not the entire hidden prefix.',
  }
}
