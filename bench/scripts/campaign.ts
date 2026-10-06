import { DateTime, Effect, FileSystem, Result, Schema } from 'effect'
import { join, resolve } from 'node:path'
import {
  Campaign,
  CampaignResolved,
  CampaignReceipt,
  campaignPlan,
  campaignGate,
  stageEpisodes,
  validateCampaign,
  CampaignBuild,
  buildContinuity,
  restoredCampaignErrors,
  settledAttempts,
} from '../src/campaign.ts'
import { Manifest, type Scenario } from '../src/schema.ts'
import { validateManifest } from '../src/manifest.ts'
import { Resolved } from '../src/results.ts'
import { fingerprint } from './artifact.ts'
import { sourceHash, corpusHash } from './identity.ts'
import { loadCorpus, sha256 } from './corpus.ts'
import { readJson, writeJson, appendJson, readLedger, fail, json } from './store.ts'
import { initializeRun, saveEpisode, loadRun } from './runner.ts'
import { ProviderConfig, validateProvider, providerCatalog, relay } from './relay.ts'
import { localStack } from './local.ts'
import { preflight } from './preflight.ts'
import { judgeStage, reviewBatch } from './judge.ts'
import { BlindCase } from '../src/blind.ts'
import { ProbeResult, publicEvents } from '../src/protocol.ts'
import { exceededReservation } from '../src/budget.ts'
import { campaignReport } from '../src/campaign-report.ts'

export const resolveCampaign = Effect.fn('bench.resolveCampaign')(function* (root: string, path: string) {
  const fs = yield* FileSystem.FileSystem
  const campaign = yield* readJson(path, Campaign)
  const manifests: Manifest[] = []
  const scenarios: Scenario[] = []
  for (const reference of campaign.manifests) {
    const file = resolve(root, reference.path)
    if (((yield* fs.stat(file)).mode & 0o077) !== 0 || sha256(yield* fs.readFileString(file)) !== reference.sha256)
      return yield* fail('Campaign manifest hash or private permissions changed')
    const manifest = yield* readJson(file, Manifest)
    const source = yield* loadCorpus(root, manifest)
    const errors = validateManifest(manifest, source)
    if (errors.length > 0) return yield* fail(errors.join('; '))
    manifests.push(manifest)
    scenarios.push(...source)
  }
  const errors = validateCampaign(campaign, manifests, scenarios)
  if (errors.length > 0) return yield* fail(errors.join('; '))
  const first = manifests[0]
  if (first === undefined) return yield* fail('Campaign requires real manifests')
  if (
    manifests.some(
      (m) =>
        fingerprint([m.pressure, m.modelTransport, m.buildTrial, m.summaryPrompt]) !==
        fingerprint([first.pressure, first.modelTransport, first.buildTrial, first.summaryPrompt]),
    )
  )
    return yield* fail('Campaign manifests disagree on experimental construction settings')
  const variants = [...new Map(manifests.flatMap((m) => m.variants).map((v) => [v.id, v])).values()]
  const manifest: Manifest = {
    ...first,
    name: campaign.name,
    corpus: undefined,
    preflight: undefined,
    scenarioIds: scenarios.map((s) => s.id),
    variants,
    allowance: {
      ...campaign.allowance,
      stages: campaign.stages.map((s, at) => ({ cutoff: at + 1, build: s.build, answer: s.answer, judge: s.judge })),
    },
  }
  const resolved: Resolved = {
    manifest,
    sourceHash: yield* sourceHash(root),
    scenarios,
    corpusHash: corpusHash(scenarios),
    runId: campaign.name,
    mode: 'live',
    createdAt: DateTime.formatIso(yield* DateTime.now),
  }
  return { campaign, campaignHash: fingerprint(campaign), manifests, resolved }
})

export const planCampaign = Effect.fn('bench.planCampaign')(function* (root: string, path: string) {
  const value = yield* resolveCampaign(root, path)
  return campaignPlan(value.campaign, value.manifests, value.resolved)
})
export const reportCampaign = Effect.fn('bench.reportCampaign')(function* (dir: string) {
  const value = yield* readJson(join(dir, 'campaign.json'), CampaignResolved)
  const data = yield* loadRun(dir)
  const builds = yield* readLedger(join(dir, 'builds.jsonl'), CampaignBuild)
  const report = {
    ...campaignReport(value.campaign, value.manifests, data),
    builds,
    stages: yield* readLedger(join(dir, 'campaign-stages.jsonl'), CampaignReceipt),
    humanReview:
      'Independent human templates live in blind/*.votes.template.json; import through bench:review-votes. Audit all disagreements and a balanced sample by corpus, length, category and arm. Machine results remain diagnostic.',
  }
  yield* writeJson(join(dir, 'campaign-report.json'), report)
  return {
    path: join(dir, 'campaign-report.json'),
    coverage: report.coverage,
    phases: report.phases,
    productDecision: report.productDecision,
  }
})
const openCampaignProvider = Effect.fn('bench.openCampaignProvider')(function* (
  root: string,
  dir: string,
  resolved: Resolved,
) {
  const providerPath = join(root, '.local/bench/provider.json')
  const config = yield* readJson(providerPath, ProviderConfig)
  yield* validateProvider(providerPath, config)
  const catalog = yield* providerCatalog(config)
  const models = resolved.manifest.variants.flatMap((v) => [v.writer ?? v.reader, v.reader])
  if (models.some((m) => !catalog.includes(m)))
    return yield* fail('A campaign route is absent from CLIProxy; no substitution')
  return yield* relay(resolved, join(dir, 'attempts.jsonl'), config)
})
const campaignPreflight = Effect.fn('bench.campaignPreflight')(function* (
  dir: string,
  url: string,
  value: typeof CampaignResolved.Type,
  provider: Effect.Success<ReturnType<typeof relay>>,
) {
  const first = value.manifests[0]
  if (first === undefined) return yield* fail('Missing campaign preflight corpus')
  const writers = [...new Set(value.manifests.flatMap((m) => m.variants.map((v) => v.writer ?? v.reader)))]
  const fs = yield* FileSystem.FileSystem
  for (const writer of writers) {
    const name = `${value.campaign.name}.preflight.${writer}`
    const path = join(dir, 'preflights', writer)
    yield* fs.makeDirectory(path, { recursive: true, mode: 0o700 })
    const manifest = {
      ...first,
      variants: [{ id: `preflight.${writer}`, policy: 'optchat' as const, writer, reader: 'deepseek-v4.1-flash' }],
    }
    yield* preflight(path, url, { ...value.resolved, runId: name, manifest }, provider)
  }
  yield* judgePreflight(dir, value, provider, writers)
})
const judgePreflight = Effect.fn('bench.judgePreflight')(function* (
  dir: string,
  value: typeof CampaignResolved.Type,
  provider: Effect.Success<ReturnType<typeof relay>>,
  writers: readonly string[],
) {
  const path = join(dir, 'preflights/judge.json')
  const fs = yield* FileSystem.FileSystem
  if (yield* fs.exists(path)) {
    if (!(yield* readJson(path, Schema.Struct({ passed: Schema.Boolean }))).passed)
      return yield* fail('Recorded judge preflight failed; no implicit rerun')
    return
  }
  const operation = `${value.campaign.name}.preflight.judge`
  if (provider.allTraces().some((t) => t.scope === operation))
    return yield* fail('Judge preflight lacks a terminal receipt; preserve its attempts')
  const checked = yield* checkJudgePreflight(dir, value, provider, writers, operation).pipe(Effect.result)
  const receipt = Result.isSuccess(checked) ? checked.success : { passed: false, error: json(checked.failure) }
  yield* writeJson(path, receipt)
  if (!receipt.passed) return yield* fail('Real-answer judge preflight failed; bulk construction remains closed')
})
const checkJudgePreflight = Effect.fn('bench.checkJudgePreflight')(function* (
  dir: string,
  value: typeof CampaignResolved.Type,
  provider: Effect.Success<ReturnType<typeof relay>>,
  writers: readonly string[],
  operation: string,
) {
  const config = value.manifests[0]?.preflight
  const scenario = value.resolved.scenarios?.find((s) => s.id === config?.scenarioId)
  if (config === undefined || scenario === undefined) return yield* fail('Missing real-source judge preflight')
  const items: BlindCase[] = []
  for (const writer of writers) {
    const receipt = yield* readJson(
      join(dir, 'preflights', writer, 'preflight.json'),
      Schema.Struct({ native: ProbeResult }),
    )
    items.push({
      caseId: fingerprint({ operation, writer }),
      category: 'evidence',
      question: 'Describe the original owner request and cite its source event.',
      label: {
        requiredClaims: [
          { key: 'owner-request', meaning: 'Describe the original owner request shown in the evidence.' },
        ],
        evidenceIds: [config.sourceId],
        mustAbstain: false,
        prohibitedClaims: [],
        rubric:
          'Compare the real native preflight answer against its original owner source; this is a transport and judge-format check, not a benchmark score.',
      },
      prefix: publicEvents(scenario.events.slice(0, config.cutoff)),
      delivered: receipt.native.deliveries,
      rawAnswer: receipt.native.text,
    })
  }
  const votes = yield* reviewBatch(items, value.campaign.judge, provider, operation, { phase: 'preflight' })
  const traces = settledAttempts(provider.allTraces().filter((t) => t.scope === operation))
  const passed =
    traces.length > 0 &&
    traces.every(
      (t) =>
        t.status === 200 &&
        !t.unknownUsage &&
        !exceededReservation(t) &&
        t.responseModel === value.campaign.judge.model,
    )
  return {
    passed,
    votes,
    actualAnswers: items.length,
    operation,
    note: 'Actual native preflight answers and their original source; diagnostic route, structure, identity and usage check only.',
  }
})
const runStage = Effect.fn('bench.campaignStage')(function* (options: {
  dir: string
  root: string
  url: string
  value: typeof CampaignResolved.Type
  index: number
  provider: Effect.Success<ReturnType<typeof relay>>
  blocked: Parameters<typeof saveEpisode>[4]
}) {
  const { value, index } = options
  const stage = value.campaign.stages[index]
  if (stage === undefined) return yield* fail('Missing campaign stage')
  const initial = yield* loadRun(options.dir)
  const planned = stageEpisodes(stage, value.manifests, value.resolved.scenarios ?? [])
  for (const episode of planned) {
    if (initial.results.some((r) => r.id === episode.id)) continue
    if (initial.traces.some((t) => t.scope === `${value.campaign.name}.${episode.id}`))
      return yield* fail('Unfinished answer evidence is preserved; no implicit retry')
    yield* saveEpisode(
      { ...options, resolved: value.resolved, resume: true, stage: index + 1 },
      episode,
      options.url,
      options.provider,
      options.blocked,
    )
  }
  const data = yield* loadRun(options.dir)
  const gate = campaignGate(planned, data.results, data.traces)
  gate.reasons.push(...buildContinuity(yield* readLedger(join(options.dir, 'builds.jsonl'), CampaignBuild)))
  gate.passed = gate.reasons.length === 0
  if (!gate.passed) return gate
  const review = yield* judgeStage({
    dir: options.dir,
    stage: index + 1,
    name: stage.id,
    episodeIds: planned.map((e) => e.id),
    campaign: value.campaign,
    provider: options.provider,
  }).pipe(Effect.result)
  if (Result.isFailure(review)) {
    yield* appendJson(join(options.dir, 'campaign-errors.jsonl'), {
      stage: stage.id,
      phase: 'judge',
      error: json(review.failure),
    })
    return { ...gate, passed: false, reasons: ['Machine review failed; exact evidence retained'] }
  }
  return campaignGate(planned, data.results, options.provider.allTraces())
})

const initializeCampaign = Effect.fn('bench.initializeCampaign')(function* (
  root: string,
  path: string,
  resume: boolean,
) {
  const candidate = yield* resolveCampaign(root, path)
  const dir = join(root, '.local/bench/runs', candidate.campaign.name)
  const value = resume ? yield* readJson(join(dir, 'campaign.json'), CampaignResolved) : candidate
  if (
    value.campaignHash !== candidate.campaignHash ||
    value.resolved.sourceHash !== candidate.resolved.sourceHash ||
    value.resolved.corpusHash !== candidate.resolved.corpusHash ||
    fingerprint(value.manifests) !== fingerprint(candidate.manifests)
  )
    return yield* fail('Campaign source, corpus or manifest identity changed')
  yield* initializeRun({ root, dir, resolved: value.resolved, resume })
  if (!resume) {
    yield* writeJson(join(dir, 'campaign.json'), value)
    yield* writeJson(join(dir, 'dry-plan.json'), campaignPlan(value.campaign, value.manifests, value.resolved))
  }
  const receipts = yield* readLedger(join(dir, 'campaign-stages.jsonl'), CampaignReceipt)
  if (receipts.some((r) => r.campaignHash !== value.campaignHash || !r.passed))
    return yield* fail('Campaign has a failed or mismatched durable stage; no implicit rerun')
  if (receipts.some((r, at) => r.stage !== value.campaign.stages[at]?.id))
    return yield* fail('Campaign stage receipts are not a monotonic prefix')
  const restorationErrors = restoredCampaignErrors(
    value.campaign,
    value.manifests,
    yield* loadRun(dir),
    yield* readLedger(join(dir, 'builds.jsonl'), CampaignBuild),
    receipts,
  )
  if (restorationErrors.length > 0) return yield* fail(restorationErrors.join('; '))
  return { value, dir, receipts }
})
export const runCampaign = Effect.fn('bench.runCampaign')(function* (root: string, path: string, resume: boolean) {
  const { value, dir, receipts } = yield* initializeCampaign(root, path, resume)
  if (receipts.length === value.campaign.stages.length)
    return { dir, complete: true, reused: true, inferenceStarted: false }
  const provider = yield* openCampaignProvider(root, dir, value.resolved)
  const { url } = yield* localStack
  const readiness = yield* campaignPreflight(dir, url, value, provider).pipe(Effect.result)
  if (Result.isFailure(readiness)) {
    yield* writeJson(join(dir, 'campaign-preflight.json'), { passed: false, error: json(readiness.failure) })
    yield* reportCampaign(dir)
    return {
      dir,
      stopped: true,
      phase: 'preflight',
      reason: 'Native preflight failed; preserved private receipts contain the cause',
      totals: provider.totals(),
    }
  }
  yield* writeJson(join(dir, 'campaign-preflight.json'), { passed: true })
  const blockedPath = join(dir, 'blocked-checkpoints.jsonl')
  const actors = new Set((yield* readLedger(blockedPath, Schema.Struct({ actor: Schema.String }))).map((r) => r.actor))
  const blocked = {
    has: (actor: string) => actors.has(actor),
    record: (actor: string) =>
      appendJson(blockedPath, { actor }).pipe(Effect.tap(() => Effect.sync(() => actors.add(actor)))),
  }
  for (const [index, stage] of value.campaign.stages.entries()) {
    if (receipts.some((r) => r.stage === stage.id)) continue
    const attempt = yield* runStage({ root, dir, url, value, index, provider, blocked }).pipe(Effect.result)
    if (Result.isFailure(attempt))
      yield* appendJson(join(dir, 'campaign-errors.jsonl'), {
        stage: stage.id,
        phase: 'execution',
        error: json(attempt.failure),
      })
    const gate = Result.isSuccess(attempt)
      ? attempt.success
      : {
          passed: false,
          reasons: ['Stage execution failed; native and upstream traces retained'],
          planned: 0,
          completed: 0,
          total: provider.totals(),
        }
    const receipt = {
      ...gate,
      campaignHash: value.campaignHash,
      stage: stage.id,
      at: DateTime.formatIso(yield* DateTime.now),
    }
    yield* appendJson(join(dir, 'campaign-stages.jsonl'), receipt)
    const data = yield* loadRun(dir)
    yield* writeJson(join(dir, 'result.json'), data)
    yield* reportCampaign(dir)
    yield* appendJson(join(dir, 'progress.jsonl'), { stage: stage.id, ...gate, at: receipt.at })
    if (!gate.passed) return { dir, stage: stage.id, stopped: true, ...gate }
  }
  return { dir, complete: true, totals: provider.totals(), humanReviewRequired: true, promotion: false }
})
