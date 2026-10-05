import { episodes } from './plan.ts'
import { semanticOutcome } from './semantic.ts'
import { stageGate } from './stages.ts'
import { Policy } from './schema.ts'
import type { EpisodeResult, RunData } from './results.ts'

type PolicyValue = typeof Policy.Type
const resultFor = (data: RunData, id: string) => data.results.find((result) => result.id === id)
const assessed = (data: RunData, id: string) =>
  semanticOutcome(
    resultFor(data, id),
    (data.semanticVotes ?? []).filter((vote) => vote.episodeId === id),
  )
const supported = (result: EpisodeResult | undefined, assessment: ReturnType<typeof assessed>) =>
  assessment.final?.searchSupported === true &&
  result?.deliveries?.some(
    (receipt) =>
      (receipt.origin === 'search' || receipt.origin === 'read') && assessment.final?.evidenceIds.includes(receipt.id),
  ) === true
function pairRow(data: RunData, baseline: string, candidate: string, probe: import('./schema.ts').Probe) {
  const before = assessed(data, `${probe.id}.${baseline}`)
  const after = assessed(data, `${probe.id}.${candidate}`)
  const comparable = before.final !== undefined && after.final !== undefined
  return {
    probe: probe.id,
    cutoff: probe.cutoff,
    category: probe.category,
    comparable,
    gain: comparable && before.semanticPass === false && after.semanticPass === true,
    loss: comparable && before.semanticPass === true && after.semanticPass === false,
    strictGain: comparable && before.strictPass === false && after.strictPass === true,
    strictLoss: comparable && before.strictPass === true && after.strictPass === false,
    baselineSemantic: before.semanticPass,
    candidateSemantic: after.semanticPass,
    evidencePass: after.evidencePass,
    searchSupportedGain:
      comparable &&
      before.semanticPass === false &&
      after.semanticPass === true &&
      supported(resultFor(data, `${probe.id}.${candidate}`), after),
  }
}
function decisionText(complete: boolean, promising: boolean, gains: number, losses: number) {
  if (!complete) return 'Completion or human review is incomplete.'
  if (promising) return 'Promising on this development sample; validate on new real probes.'
  if (gains === 0 && losses === 0) return 'Tie: no demonstrated benefit.'
  return 'Prespecified improvement criteria were not met.'
}
function conclusion(rows: ReturnType<typeof pairRow>[], effect: 'memory' | 'search') {
  const complete = rows.length > 0 && rows.every((row) => row.comparable)
  const gains = rows.filter((row) => row.gain).length,
    losses = rows.filter((row) => row.loss).length
  const supportedGains = rows.filter((row) => row.searchSupportedGain).length
  const abstentions = rows.filter((row) => row.category === 'abstention')
  const abstentionsPass = abstentions.length > 0 && abstentions.every((row) => row.candidateSemantic === true)
  const evidencePass = rows.every((row) => row.evidencePass === true)
  const searchGate = effect !== 'search' || (supportedGains >= 2 && supportedGains === gains)
  const promising = complete && gains >= 2 && losses === 0 && abstentionsPass && evidencePass && searchGate
  return {
    complete,
    gains,
    losses,
    supportedGains,
    abstentionsPass,
    evidencePass,
    promising,
    conclusion: decisionText(complete, promising, gains, losses),
  }
}
function comparison(data: RunData, baseline: string, candidate: string, effect: 'memory' | 'search') {
  const rows = episodes(data.resolved.manifest, data.resolved.scenarios)
    .filter((episode) => episode.variant.id === baseline)
    .map(({ probe }) => pairRow(data, baseline, candidate, probe))
  const result = conclusion(rows, effect)
  return {
    effect,
    baseline,
    candidate,
    plannedPairs: rows.length,
    resolvedPairs: rows.filter((row) => row.comparable).length,
    gains: result.gains,
    losses: result.losses,
    strictGains: rows.filter((row) => row.strictGain).length,
    strictLosses: rows.filter((row) => row.strictLoss).length,
    searchSupportedGains: result.supportedGains,
    complete: result.complete,
    abstentionsPass: result.abstentionsPass,
    evidencePass: result.evidencePass,
    promising: data.resolved.mode === 'live' && data.resolved.manifest.corpus !== undefined && result.promising,
    conclusion: result.conclusion,
    rows,
  }
}
/** Coupled four-arm comparison. No model ranking or production promotion. */
export function factorial(data: RunData) {
  const variants = data.resolved.manifest.variants
  const pairs: readonly [PolicyValue, PolicyValue, 'memory' | 'search'][] = [
    ['standard', 'optchat', 'memory'],
    ['standard-search', 'optchat-search', 'memory'],
    ['standard', 'standard-search', 'search'],
    ['optchat', 'optchat-search', 'search'],
  ]
  const comparisons = pairs.flatMap(([baselinePolicy, candidatePolicy, effect]) => {
    const baseline = variants.find((variant) => variant.policy === baselinePolicy)
    const candidate = variants.find(
      (variant) =>
        variant.policy === candidatePolicy &&
        variant.reader === baseline?.reader &&
        (variant.writer ?? variant.reader) === (baseline?.writer ?? baseline?.reader),
    )
    return baseline === undefined || candidate === undefined
      ? []
      : [comparison(data, baseline.id, candidate.id, effect)]
  })
  const cutoffs = episodes(data.resolved.manifest, data.resolved.scenarios).map((episode) => episode.probe.cutoff)
  const gate = stageGate(data, Math.max(...cutoffs))
  const complete = comparisons.length === 4 && comparisons.every((item) => item.complete) && gate.passed
  return {
    complete,
    operationalGate: gate,
    comparisons: comparisons.map((item) => ({
      ...item,
      promising: complete && item.promising,
      conclusion: complete ? item.conclusion : 'Completion, usage or human review is incomplete; diagnostic only.',
    })),
    scope:
      'Development recall diagnosis only. A continuation experiment requires credible recall evidence and fresh real tasks.',
  }
}
