import { Schema } from 'effect'
import { Manifest, type Scenario } from './schema.ts'
import { episodes, type Episode } from './plan.ts'
import { exceededReservation, type Totals } from './budget.ts'
import { Resolved, type EpisodeResult, type Trace, type RunData } from './results.ts'
import { fingerprint } from '../scripts/artifact.ts'

const Limits = Schema.Struct({ maxRequests: Schema.Int, maxInputTokens: Schema.Int, maxOutputTokens: Schema.Int })
export const CampaignStage = Schema.Struct({
  id: Schema.String,
  manifest: Schema.String,
  cutoff: Schema.Int,
  variants: Schema.Array(Schema.String),
  build: Limits,
  answer: Limits,
  judge: Limits,
})
export type CampaignStage = typeof CampaignStage.Type
export const Campaign = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  name: Schema.String,
  manifests: Schema.Array(Schema.Struct({ path: Schema.String, sha256: Schema.String })),
  allowance: Manifest.fields.allowance,
  stages: Schema.Array(CampaignStage),
  judge: Schema.Struct({ model: Schema.Literal('muse-spark-1.3-contributor'), maxOutputTokens: Schema.Int }),
})
export type Campaign = typeof Campaign.Type
export const CampaignResolved = Schema.Struct({
  campaign: Campaign,
  campaignHash: Schema.String,
  manifests: Schema.Array(Manifest),
  resolved: Resolved,
})
export const CampaignReceipt = Schema.Struct({
  campaignHash: Schema.String,
  stage: Schema.String,
  at: Schema.String,
  passed: Schema.Boolean,
  reasons: Schema.Array(Schema.String),
  planned: Schema.Int,
  completed: Schema.Int,
  total: Schema.Struct({ requests: Schema.Int, input: Schema.Number, output: Schema.Number }),
})
export type CampaignReceipt = typeof CampaignReceipt.Type
export const CampaignBuild = Schema.Struct({
  episodeId: Schema.String,
  actor: Schema.String,
  stage: Schema.Int,
  buildMs: Schema.Number,
  attempts: Schema.Array(Schema.Int),
  build: Schema.Struct({
    status: Schema.Literals(['cold', 'extended', 'reused']),
    sourceCount: Schema.Int,
    previousSourceCount: Schema.Int,
    newlyProcessedSourceCount: Schema.Int,
    memorySize: Schema.NullOr(Schema.Int),
    viewThrough: Schema.NullOr(Schema.Int),
  }),
})
export type CampaignBuild = typeof CampaignBuild.Type
export function buildContinuity(records: readonly CampaignBuild[]): string[] {
  const errors: string[] = []
  const previous = new Map<string, CampaignBuild['build']>()
  for (const record of records) {
    const prior = previous.get(record.actor)
    const build = record.build
    const expected = prior?.sourceCount ?? 0
    if (build.previousSourceCount !== expected || build.newlyProcessedSourceCount !== build.sourceCount - expected)
      errors.push('Memory build did not extend its exact prior prefix')
    if (build.status === 'reused' && (record.attempts.length !== 0 || build.newlyProcessedSourceCount !== 0))
      errors.push('Reused memory issued construction calls or reprocessed source')
    if ((build.memorySize ?? 0) < (prior?.memorySize ?? 0) || (build.viewThrough ?? 0) < (prior?.viewThrough ?? 0))
      errors.push('Persistent memory moved backwards')
    previous.set(record.actor, build)
  }
  return errors
}

export function stageEpisodes(
  stage: CampaignStage,
  manifests: readonly Manifest[],
  scenarios: readonly Scenario[],
): Episode[] {
  const manifest = manifests.find((item) => item.name === stage.manifest)
  if (manifest === undefined) return []
  return episodes(manifest, scenarios)
    .filter((episode) => episode.probe.cutoff === stage.cutoff && stage.variants.includes(episode.variant.id))
    .toSorted(
      (a, b) =>
        a.probe.id.localeCompare(b.probe.id) ||
        fingerprint({ campaign: manifest.campaignId, episode: a.id }).localeCompare(
          fingerprint({ campaign: manifest.campaignId, episode: b.id }),
        ),
    )
}
const keys = ['maxRequests', 'maxInputTokens', 'maxOutputTokens'] as const
function envelopeErrors(campaign: Campaign): string[] {
  const errors: string[] = []
  const allowance = campaign.allowance
  if (!/^[a-zA-Z0-9_.-]+$/u.test(campaign.name)) errors.push('Use a simple campaign name')
  if (
    allowance.maxRequests > 2000 ||
    allowance.maxInputTokens > 10_000_000 ||
    allowance.maxOutputTokens > 500_000 ||
    allowance.concurrency !== 1 ||
    allowance.maxRequestsPerAnswer !== 6
  )
    errors.push('Campaign exceeds the approved overnight envelope')
  if (allowance.phases?.judge === undefined) errors.push('Every campaign must budget machine review')
  if (campaign.judge.maxOutputTokens < 1000 || campaign.judge.maxOutputTokens > 8192)
    errors.push('Invalid reasoning-inclusive judge output cap')
  return errors
}
function manifestErrors(campaign: Campaign, manifests: readonly Manifest[]) {
  const errors: string[] = []
  if (
    new Set(manifests.map((m) => m.name)).size !== manifests.length ||
    new Set(campaign.stages.map((s) => s.id)).size !== campaign.stages.length
  )
    errors.push('Campaign manifest and stage identities must be unique')
  if (
    manifests.some((m) => m.campaignId !== campaign.name || m.corpus === undefined || m.allowance.stages !== undefined)
  )
    errors.push('Campaign manifests must bind a real corpus, campaign identity and coordinator-owned stages')
  if (manifests.some((m) => m.variants.some((v) => v.reader !== 'deepseek-v4.1-flash')))
    errors.push('Campaign holds the DeepSeek reader constant')
  return errors
}
function phaseErrors(campaign: Campaign, phase: 'preflight' | 'build' | 'answer' | 'judge') {
  const limits = campaign.allowance.phases?.[phase]
  if (limits === undefined) return [`Missing ${phase} envelope`]
  const errors: string[] = []
  if (keys.some((key) => limits[key] <= 0)) errors.push(`Invalid ${phase} envelope`)
  if (phase !== 'preflight' && keys.some((key) => campaign.stages.reduce((n, s) => n + s[phase][key], 0) > limits[key]))
    errors.push(`Stages exceed ${phase} envelope`)
  return errors
}
export function validateCampaign(
  campaign: Campaign,
  manifests: readonly Manifest[],
  scenarios: readonly Scenario[],
): string[] {
  const errors = [...envelopeErrors(campaign), ...manifestErrors(campaign, manifests)]
  const allowance = campaign.allowance
  for (const phase of ['preflight', 'build', 'answer', 'judge'] as const) errors.push(...phaseErrors(campaign, phase))
  if (
    keys.some(
      (key) =>
        Object.values(allowance.phases ?? {}).reduce((n, limits) => n + (limits?.[key] ?? 0), 0) > allowance[key],
    )
  )
    errors.push('Campaign phase envelopes exceed global budget')
  const selected = campaign.stages.flatMap((stage) => stageEpisodes(stage, manifests, scenarios))
  if (selected.length > allowance.maxAnswers || new Set(selected.map((e) => e.id)).size !== selected.length)
    errors.push('Duplicate answers or answer allowance exceeded')
  errors.push(...stagePlanErrors(campaign, manifests, scenarios))
  return errors
}
function stagePlanErrors(campaign: Campaign, manifests: readonly Manifest[], scenarios: readonly Scenario[]) {
  const errors: string[] = []
  const previous = new Map<string, number>()
  for (const stage of campaign.stages) {
    errors.push(...singleStageErrors(stage, manifests, scenarios))
    if (stage.cutoff <= (previous.get(stage.manifest) ?? 0)) errors.push(`Non-monotonic checkpoint ${stage.id}`)
    previous.set(stage.manifest, stage.cutoff)
  }
  return errors
}
function singleStageErrors(stage: CampaignStage, manifests: readonly Manifest[], scenarios: readonly Scenario[]) {
  const errors: string[] = []
  const selected = stageEpisodes(stage, manifests, scenarios)
  const manifest = manifests.find((m) => m.name === stage.manifest)
  if (
    manifest === undefined ||
    stage.variants.some((id) => !manifest.variants.some((v) => v.id === id)) ||
    selected.length !== stage.variants.length * 5
  )
    errors.push(`Stage ${stage.id} must select five real probes per declared arm`)
  if (selected.some((e) => e.probe.label === undefined)) errors.push(`Stage ${stage.id} lacks prefix labels`)
  if (new Set(selected.map((e) => e.probe.category)).size !== 5)
    errors.push(`Stage ${stage.id} requires five balanced categories`)
  if (
    ['build', 'answer', 'judge'].some((phase) => {
      const limits = phase === 'build' ? stage.build : phase === 'answer' ? stage.answer : stage.judge
      return keys.some((key) => limits[key] <= 0)
    })
  )
    errors.push(`Invalid stage envelope ${stage.id}`)
  return errors
}
export const settledAttempts = (traces: readonly Trace[]) => [...new Map(traces.map((t) => [t.attempt, t])).values()]
export const campaignTotals = (traces: readonly Trace[]): Totals =>
  settledAttempts(traces).reduce(
    (n, t) => ({
      requests: n.requests + 1,
      input: n.input + t.input,
      output: n.output + t.output,
    }),
    { requests: 0, input: 0, output: 0 },
  )
export function campaignGate(planned: readonly Episode[], results: readonly EpisodeResult[], traces: readonly Trace[]) {
  const completed = planned.filter((e) => results.some((r) => r.id === e.id && r.status === 'completed')).length
  const reasons: string[] = []
  if (planned.length === 0 || completed / planned.length < 0.9) reasons.push('Answer completion below 90 percent')
  const attempts = settledAttempts(traces)
  if (attempts.some((t) => t.unknownUsage || t.status === 0)) reasons.push('Unknown or unsettled usage')
  if (attempts.some(exceededReservation)) reasons.push('Provider reservation breach')
  return { passed: reasons.length === 0, reasons, planned: planned.length, completed, total: campaignTotals(traces) }
}
/** Restore only an ordered, identity-matching prefix whose operational and review evidence still passes. */
export function restoredCampaignErrors(
  campaign: Campaign,
  manifests: readonly Manifest[],
  data: RunData,
  builds: readonly CampaignBuild[],
  receipts: readonly CampaignReceipt[],
): string[] {
  const errors: string[] = []
  for (const [index, receipt] of receipts.entries()) {
    const stage = campaign.stages[index]
    if (stage === undefined || receipt.stage !== stage.id || receipt.campaignHash !== fingerprint(campaign)) {
      errors.push('Campaign stage receipts are not an identity-matching ordered prefix')
      continue
    }
    const planned = stageEpisodes(stage, manifests, data.resolved.scenarios ?? [])
    const traces = data.traces.filter((t) => t.phase === 'preflight' || (t.stage ?? Infinity) <= index + 1)
    const gate = campaignGate(planned, data.results, traces)
    if (
      !receipt.passed ||
      !gate.passed ||
      receipt.planned !== gate.planned ||
      receipt.completed !== gate.completed ||
      fingerprint(receipt.total) !== fingerprint(gate.total)
    )
      errors.push(`Recorded stage ${stage.id} does not match restored operational evidence`)
    if (
      planned.some(
        (e) =>
          data.results.some((r) => r.id === e.id && r.status === 'completed') &&
          !data.semanticVotes?.some((v) => v.episodeId === e.id && v.kind === 'machine'),
      )
    )
      errors.push(`Recorded stage ${stage.id} lacks sealed machine review`)
  }
  errors.push(...buildContinuity(builds))
  return errors
}
export function campaignPlan(campaign: Campaign, manifests: readonly Manifest[], resolved: Resolved) {
  const scenarios = resolved.scenarios ?? []
  return {
    campaign: campaign.name,
    campaignHash: fingerprint(campaign),
    sourceHash: resolved.sourceHash,
    corpusHash: resolved.corpusHash,
    errors: validateCampaign(campaign, manifests, scenarios),
    allowance: campaign.allowance,
    reader: 'deepseek-v4.1-flash',
    judge: campaign.judge,
    answers: campaign.stages.reduce((n, s) => n + stageEpisodes(s, manifests, scenarios).length, 0),
    stages: campaign.stages.map((s) => ({ ...s, answers: stageEpisodes(s, manifests, scenarios).length })),
    inferenceStarted: false,
    promotion: false,
  }
}
