import { DateTime, Duration, Effect, FileSystem, Schema, Result } from 'effect'
import { join } from 'node:path'
import { episodes, type Episode } from '../src/plan.ts'
import { dataset } from '../src/fixtures.ts'
import { buildPolicy } from '../src/schema.ts'
import { ProbeResult, publicEvents } from '../src/protocol.ts'
import { EpisodeResult, Resolved, Trace } from '../src/results.ts'
import { applyReview, Review } from '../src/review.ts'
import { loadCorpus } from './corpus.ts'
import { evaluated, failedScore } from '../src/evaluate.ts'
import { localStack } from './local.ts'
import { relay, ProviderConfig, validateProvider, providerCatalog } from './relay.ts'
import { artifactIdentity, sourceHash, corpusHash, digest, fingerprint } from './identity.ts'
import { admitHoldout } from './holdout.ts'
import { preflight } from './preflight.ts'
import { post } from './native.ts'
import { fail, json, lockRun, readJson, writeJson, appendJson, readLedger } from './store.ts'
import { StageReceipt, stageAdmission, stageGate } from '../src/stages.ts'
import { SemanticVote } from '../src/semantic.ts'

const executeEpisode = Effect.fn('bench.episode')(function* (
  url: string,
  resolved: Resolved,
  episode: Episode,
  provider: Effect.Success<ReturnType<typeof relay>>,
  blocked: {
    has: (actor: string) => boolean
    record: (actor: string) => Effect.Effect<void, unknown, FileSystem.FileSystem>
  },
) {
  const scenario = (resolved.scenarios ?? dataset()).find((item) => item.id === episode.probe.scenarioId)
  if (scenario === undefined) return yield* fail('Unknown scenario')
  const actor = artifactIdentity(resolved, scenario.id, episode.variant)
  if (blocked.has(actor))
    return yield* fail('Checkpoint build previously failed in this run; dependent episodes remain blocked')
  provider.setScope(actor, 'build', episode.probe.cutoff)
  const [buildDuration, build] = yield* post(url, 'build', actor, {
    identity: actor,
    manifest: resolved.manifest,
    policy: buildPolicy(episode.variant.policy),
    writer: episode.variant.writer ?? episode.variant.reader,
    events: publicEvents(scenario.events.slice(0, episode.probe.cutoff)),
  }).pipe(
    Effect.tapError(() => blocked.record(actor)),
    Effect.timed,
  )
  const operationId = `${resolved.runId}.${episode.id}`
  provider.setScope(operationId, 'answer', episode.probe.cutoff)
  const [answerDuration, raw] = yield* post(url, 'probe', actor, {
    id: operationId,
    reader: episode.variant.reader,
    cutoff: episode.probe.cutoff,
    recallGuide: resolved.manifest.recallGuide,
    question: `${episode.probe.question}\nUse claim keys: ${episode.probe.keys.join(', ')}.`,
    search: episode.variant.policy === 'standard-search' || episode.variant.policy === 'optchat-search',
  }).pipe(Effect.timed)
  const native = yield* Schema.decodeUnknownEffect(ProbeResult)(raw)
  return {
    result: evaluated(resolved, episode, native),
    native,
    actor,
    build,
    timing: { buildMs: Duration.toMillis(buildDuration), answerMs: Duration.toMillis(answerDuration) },
  }
})

export const loadRun = Effect.fn('bench.loadRun')(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem
  const resolved = yield* readJson(join(dir, 'resolved.json'), Resolved)
  const results = yield* Effect.forEach(
    (yield* fs.readDirectory(join(dir, 'episodes'))).filter((name) => name.endsWith('.json')).toSorted(),
    (name) => readJson(join(dir, 'episodes', name), EpisodeResult),
  )
  const reviews = yield* readLedger(join(dir, 'reviews.jsonl'), Review)
  const semanticVotes = yield* readLedger(join(dir, 'semantic-reviews.jsonl'), SemanticVote)
  for (const vote of semanticVotes) {
    const result = results.find((item) => item.id === vote.episodeId)
    if (
      vote.runId !== resolved.runId ||
      vote.sourceHash !== resolved.sourceHash ||
      vote.corpusHash !== resolved.corpusHash ||
      result === undefined ||
      fingerprint(result) !== vote.resultHash
    )
      return yield* fail('Semantic review identity or answer changed')
  }
  const reviewed = yield* Effect.try({
    try: () =>
      results.map((result) => {
        const review = reviews.findLast((item) => item.episodeId === result.id)
        return review === undefined ? result : applyReview(resolved, result, review)
      }),
    catch: () => fail('Invalid semantic review ledger'),
  })
  return {
    resolved,
    results: reviewed,
    traces: yield* readLedger(join(dir, 'attempts.jsonl'), Trace),
    semanticVotes,
    stageReceipts: yield* readLedger(join(dir, 'stages.jsonl'), StageReceipt),
  }
})

const openProvider = Effect.fn('bench.openProvider')(function* (options: {
  dir: string
  root: string
  resolved: Resolved
  providerPath?: string
}) {
  const providerConfig =
    options.resolved.mode === 'fake'
      ? undefined
      : yield* readJson(options.providerPath ?? join(options.root, '.local/bench/provider.json'), ProviderConfig)
  if (providerConfig !== undefined) {
    yield* validateProvider(options.providerPath ?? join(options.root, '.local/bench/provider.json'), providerConfig)
    const offered = yield* providerCatalog(providerConfig)
    const needed = options.resolved.manifest.variants.flatMap((variant) => [
      variant.reader,
      variant.writer ?? variant.reader,
    ])
    if (needed.some((model) => !offered.includes(model)))
      return yield* fail('Manifest selects a model absent from the CLIProxy catalog')
  }
  return yield* relay(options.resolved, join(options.dir, 'attempts.jsonl'), providerConfig)
})

type RunOptions = {
  dir: string
  root: string
  resolved: Resolved
  resume: boolean
  providerPath?: string
  untilCutoff?: number
}
const initializeRun = Effect.fn('bench.initializeRun')(function* (options: RunOptions) {
  const fs = yield* FileSystem.FileSystem
  yield* lockRun(options.dir)
  const path = join(options.dir, 'resolved.json')
  if (options.resume) {
    const existing = yield* readJson(path, Resolved)
    if (digest(existing) !== digest(options.resolved)) return yield* fail('Resume identity mismatch')
  } else {
    if (yield* fs.exists(path)) return yield* fail('Run already exists; use resume with its immutable manifest')
    yield* fs.makeDirectory(join(options.dir, 'episodes'), { mode: 0o700 })
    yield* fs.makeDirectory(join(options.dir, 'traces'), { mode: 0o700 })
    yield* writeJson(path, options.resolved)
  }
})
const saveEpisode = Effect.fn('bench.saveEpisode')(function* (
  options: RunOptions,
  episode: Episode,
  url: string,
  provider: Effect.Success<ReturnType<typeof relay>>,
  blocked: Parameters<typeof executeEpisode>[4],
) {
  const episodePath = join(options.dir, 'episodes', `${episode.id}.json`)
  const [duration, completed] = yield* executeEpisode(url, options.resolved, episode, provider, blocked).pipe(
    Effect.result,
    Effect.timed,
  )
  const episodeMs = Duration.toMillis(duration)
  if (Result.isSuccess(completed)) {
    const result = { ...completed.success.result, timing: { episodeMs, ...completed.success.timing } }
    yield* writeJson(join(options.dir, 'traces', `${episode.id}.json`), { ...completed.success, result })
    yield* writeJson(episodePath, result)
  } else {
    const result: EpisodeResult = {
      id: episode.id,
      variant: episode.variant.id,
      category: episode.probe.category,
      status: 'failed',
      answer: null,
      score: failedScore,
      malformed: false,
      futureLeakage: false,
      unauthorizedReads: false,
      forbiddenEndorsement: false,
      deliveredIds: [],
      detail: 'Execution failed; inspect attempts and native logs',
      timing: { episodeMs },
    }
    yield* writeJson(episodePath, result)
    yield* appendJson(join(options.dir, 'failures.jsonl'), { id: episode.id, error: json(completed.failure) })
  }
})
const finalizeRun = Effect.fn('bench.finalizeRun')(function* (
  options: RunOptions,
  cutoff: number | undefined,
  receipts: readonly StageReceipt[],
) {
  const data = yield* loadRun(options.dir)
  if (cutoff !== undefined && !receipts.some((receipt) => receipt.cutoff === cutoff))
    yield* appendJson(join(options.dir, 'stages.jsonl'), {
      runId: options.resolved.runId,
      sourceHash: options.resolved.sourceHash,
      corpusHash: options.resolved.corpusHash,
      cutoff,
      ...stageGate(data, cutoff),
      at: DateTime.formatIso(yield* DateTime.now),
    })
  yield* writeJson(join(options.dir, 'result.json'), data)
  return {
    answers: data.results.length,
    correct: data.results.filter((item) => item.score.correct).length,
    cutoff,
    operationalGate: cutoff === undefined ? undefined : stageGate(data, cutoff),
  }
})
export const run = Effect.fn('bench.run')(function* (options: RunOptions) {
  yield* initializeRun(options)
  const initial = yield* loadRun(options.dir)
  const receipts = yield* readLedger(join(options.dir, 'stages.jsonl'), StageReceipt)
  const admission = stageAdmission(initial, receipts, options.untilCutoff)
  if (admission.reasons.length > 0) return yield* fail(admission.reasons.join('; '))
  const selected = episodes(options.resolved.manifest, options.resolved.scenarios)
    .filter((episode) => admission.cutoff === undefined || episode.probe.cutoff <= admission.cutoff)
    .filter((episode) => !initial.results.some((result) => result.id === episode.id))
  const unfinished = selected.some((episode) =>
    initial.traces.some((trace) => trace.scope === `${options.resolved.runId}.${episode.id}`),
  )
  if (unfinished) return yield* fail('Unfinished answer evidence is preserved; start a fresh named trial')
  if (selected.length === 0) return yield* finalizeRun(options, admission.cutoff, receipts)
  const provider = yield* openProvider(options)
  yield* admitHoldout(options.root, options.resolved)
  const { url } = yield* localStack
  yield* preflight(options.dir, url, options.resolved, provider)
  const blockedPath = join(options.dir, 'blocked-checkpoints.jsonl')
  const blockedActors = new Set(
    (yield* readLedger(blockedPath, Schema.Struct({ actor: Schema.String }))).map((item) => item.actor),
  )
  const blocked = {
    has: (actor: string) => blockedActors.has(actor),
    record: (actor: string) =>
      appendJson(blockedPath, { actor }).pipe(Effect.tap(() => Effect.sync(() => blockedActors.add(actor)))),
  }
  for (const episode of selected) yield* saveEpisode(options, episode, url, provider, blocked)
  return yield* finalizeRun(options, admission.cutoff, receipts)
})

export const resolveRun = Effect.fn('bench.resolveRun')(function* (
  root: string,
  manifest: Resolved['manifest'],
  runId: string,
  mode: Resolved['mode'],
) {
  const now = yield* DateTime.now
  const scenarios = yield* loadCorpus(root, manifest)
  if (manifest.corpus !== undefined && mode !== 'live') return yield* fail('Real corpora require --live')
  return {
    manifest,
    sourceHash: yield* sourceHash(root),
    corpusHash: corpusHash(scenarios),
    ...(manifest.corpus === undefined ? {} : { scenarios }),
    runId,
    mode,
    createdAt: DateTime.formatIso(now),
  } satisfies Resolved
})
