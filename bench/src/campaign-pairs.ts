import type { Campaign } from './campaign.ts'
import type { Manifest } from './schema.ts'
import type { CampaignAnswer } from './campaign-report.ts'

type Row = CampaignAnswer
const average = (values: readonly number[]) =>
  values.length === 0 ? null : values.reduce((n, value) => n + value, 0) / values.length
const ratio = (after: number | null, before: number | null) =>
  after === null || before === null || before <= 0 ? null : after / before
function pairedScore(pairs: readonly { baseline: Row; candidate: Row }[], human: boolean) {
  const score = (row: Row) => (human ? row.finalPass : row.machinePass)
  const comparable = pairs.filter((p) => score(p.baseline) !== null && score(p.candidate) !== null)
  const gains = comparable.filter((p) => score(p.baseline) === false && score(p.candidate) === true)
  const losses = comparable.filter((p) => score(p.baseline) === true && score(p.candidate) === false)
  const categories = [...Map.groupBy(comparable, (p) => p.baseline.category)].map(([category, group]) => ({
    category,
    pairs: group.length,
    gainPoints: 100 * (average(group.map((p) => Number(score(p.candidate)) - Number(score(p.baseline)))) ?? 0),
  }))
  return {
    reviewedPairs: comparable.length,
    complete: pairs.length > 0 && comparable.length === pairs.length,
    gainPoints: comparable.length === 0 ? null : (100 * (gains.length - losses.length)) / comparable.length,
    gains: gains.length,
    losses: losses.length,
    ties: comparable.length - gains.length - losses.length,
    citedSearchGains: gains.filter((p) => (human ? p.candidate.searchSupported : p.candidate.machineSearchSupported))
      .length,
    categories,
    unsupportedIncrease:
      comparable.length === 0
        ? null
        : comparable.reduce(
            (n, p) =>
              n +
              Number(human ? p.candidate.finalUnsupported : p.candidate.machineUnsupported) -
              Number(human ? p.baseline.finalUnsupported : p.baseline.machineUnsupported),
            0,
          ),
    leakageIncrease:
      comparable.length === 0
        ? null
        : comparable.reduce((n, p) => n + Number(p.candidate.futureLeakage) - Number(p.baseline.futureLeakage), 0),
  }
}
function compare(rows: readonly Row[], baseline: string, candidate: string, effect: 'memory' | 'search' | 'writer') {
  const pairs = rows
    .filter((r) => r.variant === baseline)
    .flatMap((before) => {
      const after = rows.find((r) => r.probeId === before.probeId && r.variant === candidate)
      return after === undefined ? [] : [{ baseline: before, candidate: after }]
    })
  const latency = (variant: string) =>
    average(
      rows
        .filter((r) => r.variant === variant)
        .flatMap((r) =>
          r.metrics?.answerMs === null || r.metrics?.answerMs === undefined ? [] : [r.metrics.answerMs],
        ),
    )
  const tokens = (variant: string) =>
    average(rows.filter((r) => r.variant === variant).map((r) => r.readerUsage.input + r.readerUsage.output))
  return {
    effect,
    baseline,
    candidate,
    plannedPairs: pairs.length,
    machineDiagnostic: pairedScore(pairs, false),
    humanResolved: pairedScore(pairs, true),
    answerLatencyRatio: pairs.every(
      (p) => p.baseline.metrics?.answerMs != null && p.candidate.metrics?.answerMs != null,
    )
      ? ratio(latency(candidate), latency(baseline))
      : null,
    chargedReaderTokenRatio: ratio(tokens(candidate), tokens(baseline)),
    amortizedDollarCostRatio: null,
    pairs: pairs.map((p) => ({
      probe: p.baseline.probeId,
      category: p.baseline.category,
      baselineSemantic: p.baseline.finalPass,
      candidateSemantic: p.candidate.finalPass,
      baselineMachine: p.baseline.machinePass,
      candidateMachine: p.candidate.machinePass,
    })),
  }
}
export function campaignComparisons(campaign: Campaign, manifests: readonly Manifest[], rows: readonly Row[]) {
  return campaign.stages.flatMap((stage) => {
    const manifest = manifests.find((m) => m.name === stage.manifest)
    const variants = manifest?.variants.filter((v) => stage.variants.includes(v.id)) ?? []
    const native = variants.find((v) => v.policy === 'standard')
    const nativeSearch = variants.find((v) => v.policy === 'standard-search')
    const optchat = variants.find((v) => v.policy === 'optchat' && v.writer === 'qwen3.8-flash')
    const optchatSearch = variants.find((v) => v.policy === 'optchat-search' && v.writer === optchat?.writer)
    const specs: { baseline: string; candidate: string; effect: 'memory' | 'search' | 'writer' }[] = []
    const add = (
      baseline: string | undefined,
      candidate: string | undefined,
      effect: 'memory' | 'search' | 'writer',
    ) => {
      if (baseline !== undefined && candidate !== undefined) specs.push({ baseline, candidate, effect })
    }
    add(native?.id, optchat?.id, 'memory')
    add(nativeSearch?.id, optchatSearch?.id, 'memory')
    add(native?.id, nativeSearch?.id, 'search')
    add(optchat?.id, optchatSearch?.id, 'search')
    for (const writer of variants.filter((v) => v.policy === 'optchat' && v.id !== optchat?.id))
      add(optchat?.id, writer.id, 'writer')
    const selected = rows.filter((r) => r.cutoff === stage.cutoff && manifest?.scenarioIds.includes(r.corpus))
    return specs.map((spec) => ({
      stage: stage.id,
      corpus: selected[0]?.corpus ?? '',
      cutoff: stage.cutoff,
      ...compare(selected, spec.baseline, spec.candidate, spec.effect),
    }))
  })
}
export function productCriteria(comparisons: ReturnType<typeof campaignComparisons>) {
  const longest = new Map<string, number>()
  for (const item of comparisons) longest.set(item.corpus, Math.max(longest.get(item.corpus) ?? 0, item.cutoff))
  return [
    ...Map.groupBy(
      comparisons.filter((c) => c.effect === 'memory'),
      (c) => `${c.baseline}/${c.candidate}`,
    ),
  ].map(([comparison, values]) => {
    const final = values.filter((v) => v.cutoff === longest.get(v.corpus))
    const complete = final.length >= 2 && final.every((v) => v.humanResolved.complete)
    const criteria = {
      gainOnBothLongCorpora: complete && final.every((v) => (v.humanResolved.gainPoints ?? -Infinity) >= 10),
      noCategoryRegressionAboveFivePoints:
        complete &&
        values.every((v) => v.humanResolved.complete && v.humanResolved.categories.every((c) => c.gainPoints >= -5)),
      noAdditionalUnsupportedClaimsOrLeakage:
        complete &&
        values.every(
          (v) =>
            (v.humanResolved.unsupportedIncrease ?? Infinity) <= 0 &&
            (v.humanResolved.leakageIncrease ?? Infinity) <= 0,
        ),
      latencyBelowTwiceNative:
        complete && final.every((v) => v.answerLatencyRatio !== null && v.answerLatencyRatio < 2),
      amortizedDollarCostBelowTwiceNative: null,
    }
    return {
      comparison,
      complete,
      criteria,
      eligible: null,
      decision: complete
        ? 'Dollar-cost criterion remains unknown without dated prices; ties favor native.'
        : 'Pending independent human resolution on both long corpora; machine scores are diagnostic.',
    }
  })
}
