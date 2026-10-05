import type { EpisodeResult, RunData } from './results.ts'
import { episodes } from './plan.ts'

const reviewed = (result: EpisodeResult | undefined): boolean =>
  result?.status === 'completed' && result.reviewStatus === 'reviewed'
const outcome = (result: EpisodeResult | undefined): string =>
  result === undefined
    ? 'missing'
    : result.status === 'failed'
      ? 'runtime failure'
      : !reviewed(result)
        ? 'review pending'
        : result.score.correct
          ? 'pass'
          : 'fail'
const operations = (result: EpisodeResult | undefined) => ({
  calls: result?.retrieval?.length ?? 0,
  denied: result?.retrieval?.filter((item) => item.denied).length ?? 0,
  returnedBytes:
    result?.retrieval
      ?.filter((item) => !item.denied)
      .reduce((n, item) => n + new TextEncoder().encode(item.text).length, 0) ?? 0,
  byTool: Object.fromEntries(
    ['zoom', 'archive_search', 'archive_read'].map((tool) => [
      tool,
      result?.retrieval?.filter((item) => item.operation === tool).length ?? 0,
    ]),
  ),
  citedOrigins:
    result?.deliveries
      ?.filter((item) => result.answer?.evidenceIds.includes(item.id))
      .map((item) => ({ id: item.id, origin: item.origin, offsetBytes: item.offsetBytes, endBytes: item.endBytes })) ??
    [],
})

function pairRow(data: RunData, probe: import('./schema.ts').Probe, baseline: string, candidate: string) {
  const before = data.results.find((item) => item.id === `${probe.id}.${baseline}`)
  const after = data.results.find((item) => item.id === `${probe.id}.${candidate}`)
  const comparable = reviewed(before) && reviewed(after)
  const gain = comparable && before?.score.correct === false && after?.score.correct === true
  const loss = comparable && before?.score.correct === true && after?.score.correct === false
  const searchSupported =
    after?.review?.searchSupported === true &&
    after.deliveries?.some(
      (item) => (item.origin === 'search' || item.origin === 'read') && after.answer?.evidenceIds.includes(item.id),
    ) === true
  return {
    probe: probe.id,
    cutoff: probe.cutoff,
    category: probe.category,
    baseline: outcome(before),
    candidate: outcome(after),
    comparable,
    gain,
    loss,
    searchSupportedGain: gain && searchSupported,
    baselineRetrieval: operations(before),
    candidateRetrieval: operations(after),
  }
}

function conclusion(allReviewed: boolean, promising: boolean, gains: number, losses: number): string {
  if (!allReviewed) return 'Operational findings only: incomplete completion or review coverage.'
  if (promising) return 'Search is promising on this development sample; validate on new real probes.'
  if (gains === 0 && losses === 0) return 'Tie: no demonstrated benefit.'
  return 'Search did not meet the prespecified success criteria.'
}

const passesCandidate = (item: EpisodeResult): boolean =>
  !item.malformed &&
  !item.futureLeakage &&
  !item.unauthorizedReads &&
  !item.forbiddenEndorsement &&
  item.score.evidenceValid &&
  !item.score.unsupported
function reportPair(data: RunData, baseline: string, candidate: string) {
  const rows = episodes(data.resolved.manifest, data.resolved.scenarios)
    .filter((episode) => episode.variant.id === baseline)
    .map(({ probe }) => pairRow(data, probe, baseline, candidate))
  const candidates = data.results.filter((item) => item.variant === candidate)
  const allReviewed = rows.length > 0 && rows.every((row) => row.comparable)
  const gains = rows.filter((row) => row.gain).length
  const losses = rows.filter((row) => row.loss).length
  const searchSupportedGains = rows.filter((row) => row.searchSupportedGain).length
  const abstentions = rows.filter((row) => row.category === 'abstention')
  const abstentionsPass = abstentions.length === 2 && abstentions.every((row) => row.candidate === 'pass')
  const candidateGates = candidates.length === rows.length && candidates.every(passesCandidate)
  const real = data.resolved.mode === 'live' && data.resolved.manifest.corpus !== undefined
  const promising =
    real && allReviewed && gains > 0 && losses === 0 && searchSupportedGains > 0 && abstentionsPass && candidateGates
  return {
    baseline,
    candidate,
    plannedPairs: rows.length,
    comparablePairs: rows.filter((row) => row.comparable).length,
    gains,
    losses,
    searchSupportedGains,
    allReviewed,
    abstentionsPass,
    candidateGates,
    promising,
    conclusion: conclusion(allReviewed, promising, gains, losses),
    rows,
  }
}

/** Paired diagnostic gate, never a promotion or statistical/model superiority claim. */
export function paired(data: RunData) {
  return data.resolved.manifest.variants
    .filter((variant) => variant.policy === 'optchat')
    .flatMap((baseline) => {
      const candidate = data.resolved.manifest.variants.find(
        (variant) =>
          variant.policy === 'optchat-search' &&
          variant.writer === baseline.writer &&
          variant.reader === baseline.reader,
      )
      return candidate === undefined ? [] : [reportPair(data, baseline.id, candidate.id)]
    })
}
