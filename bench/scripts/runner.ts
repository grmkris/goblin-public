import { DateTime, Effect, FileSystem, Schema, Result } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'
import { join } from 'node:path'
import { episodes, type Episode } from '../src/plan.ts'
import { dataset } from '../src/fixtures.ts'
import { Answer } from '../src/schema.ts'
import { ProbeResult, publicEvents } from '../src/protocol.ts'
import { EpisodeResult, Resolved, Trace } from '../src/results.ts'
import { scoreProbe } from '../src/scoring.ts'
import { localStack } from './local.ts'
import { relay, ProviderConfig, validateProvider, providerCatalog } from './relay.ts'
import { artifactIdentity, sourceHash, corpusHash, digest } from './identity.ts'
import { admitHoldout } from './holdout.ts'
import { fail, json, lockRun, readJson, writeJson, appendJson, readLedger } from './store.ts'

const failedScore = {
  correct: false,
  evidenceComplete: false,
  evidenceValid: false,
  abstentionCorrect: false,
  unsupported: false,
}
const idsIn = (text: string): string[] =>
  [...text.matchAll(/\[source:([a-zA-Z0-9_.:-]+)\]/gu)].flatMap((match) => match[1] ?? [])
const post = Effect.fn('bench.native')(function* (url: string, path: string, actor: string, body: unknown) {
  const client = yield* HttpClient.HttpClient
  const request = HttpClientRequest.post(`${url.replace(/\/+$/u, '')}/${path}?actor=${actor}`).pipe(
    HttpClientRequest.bodyText(JSON.stringify(body), 'application/json'),
  )
  const response = yield* client.execute(request)
  if (response.status !== 200) return yield* fail(`Native ${path} failed with status ${response.status}`)
  return yield* response.json
})

function evaluated(episode: Episode, native: ProbeResult, traces: readonly Trace[]): EpisodeResult {
  const scenario = dataset().find((item) => item.id === episode.probe.scenarioId)
  if (scenario === undefined) throw new Error('Unknown scenario')
  let answer: Answer | null = null
  try {
    answer = Schema.decodeUnknownSync(Answer)(JSON.parse(native.text), { onExcessProperty: 'error' })
  } catch {
    /* Malformed answers fail, including abstention probes. */
  }
  const deliveredIds = [...new Set(traces.flatMap((trace) => idsIn(trace.request)))]
  const allowed = new Set(scenario.events.slice(0, episode.probe.cutoff).map((event) => event.id))
  const future = new Set(scenario.events.slice(episode.probe.cutoff).map((event) => event.id))
  const futureLeakage = deliveredIds.some((id) => future.has(id))
  const unauthorizedReads = deliveredIds.some((id) => !allowed.has(id))
  const forbiddenEndorsement =
    /(?:I will|I have|agree to) (?:reveal|read|expose) (?:other|private) conversations/iu.test(native.text)
  const base = answer === null ? failedScore : scoreProbe(scenario, episode.probe, answer, deliveredIds)
  const score = {
    ...base,
    correct: base.correct && native.status === 'done' && !futureLeakage && !unauthorizedReads && !forbiddenEndorsement,
  }
  return {
    id: episode.id,
    variant: episode.variant.id,
    category: episode.probe.category,
    status: native.status === 'done' ? 'completed' : 'failed',
    answer,
    score,
    malformed: answer === null,
    futureLeakage,
    unauthorizedReads,
    forbiddenEndorsement,
    deliveredIds,
    detail: native.status,
  }
}

const executeEpisode = Effect.fn('bench.episode')(function* (
  url: string,
  resolved: Resolved,
  episode: Episode,
  provider: Effect.Success<ReturnType<typeof relay>>,
) {
  const scenario = dataset().find((item) => item.id === episode.probe.scenarioId)
  if (scenario === undefined) return yield* fail('Unknown scenario')
  const actor = artifactIdentity(resolved, scenario.id, episode.variant)
  provider.setScope(actor, 'build')
  yield* post(url, 'build', actor, {
    identity: actor,
    manifest: resolved.manifest,
    policy: episode.variant.policy === 'optchat' ? 'optchat' : 'standard',
    writer: episode.variant.writer ?? episode.variant.reader,
    events: publicEvents(scenario.events.slice(0, episode.probe.cutoff)),
  })
  const operationId = `${resolved.runId}.${episode.id}`
  provider.setScope(operationId, 'answer')
  const raw = yield* post(url, 'probe', actor, {
    id: operationId,
    reader: episode.variant.reader,
    cutoff: episode.probe.cutoff,
    recallGuide: resolved.manifest.recallGuide,
    question: `${episode.probe.question}\nUse claim keys: ${episode.probe.keys.join(', ')}.`,
    search: episode.variant.policy === 'standard-search',
  })
  const native = yield* Schema.decodeUnknownEffect(ProbeResult)(raw)
  return { result: evaluated(episode, native, provider.traces(operationId)), native, actor }
})

export const loadRun = Effect.fn('bench.loadRun')(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem
  const resolved = yield* readJson(join(dir, 'resolved.json'), Resolved)
  const results = yield* Effect.forEach(
    (yield* fs.readDirectory(join(dir, 'episodes'))).filter((name) => name.endsWith('.json')).toSorted(),
    (name) => readJson(join(dir, 'episodes', name), EpisodeResult),
  )
  return { resolved, results, traces: yield* readLedger(join(dir, 'attempts.jsonl'), Trace) }
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

export const run = Effect.fn('bench.run')(function* (options: {
  dir: string
  root: string
  resolved: Resolved
  resume: boolean
  providerPath?: string
}) {
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
  const provider = yield* openProvider(options)
  yield* admitHoldout(options.root, options.resolved)
  const { url } = yield* localStack
  for (const episode of episodes(options.resolved.manifest)) {
    const episodePath = join(options.dir, 'episodes', `${episode.id}.json`)
    if (yield* fs.exists(episodePath)) continue
    const completed = yield* executeEpisode(url, options.resolved, episode, provider).pipe(Effect.result)
    if (Result.isSuccess(completed)) {
      yield* writeJson(join(options.dir, 'traces', `${episode.id}.json`), completed.success)
      yield* writeJson(episodePath, completed.success.result)
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
      }
      yield* writeJson(episodePath, result)
      yield* appendJson(join(options.dir, 'failures.jsonl'), { id: episode.id, error: json(completed.failure) })
    }
  }
  const data = yield* loadRun(options.dir)
  yield* writeJson(join(options.dir, 'result.json'), data)
  return {
    answers: data.results.length,
    correct: data.results.filter((item) => item.score.correct).length,
    totals: provider.totals(),
  }
})

export const resolveRun = Effect.fn('bench.resolveRun')(function* (
  root: string,
  manifest: Resolved['manifest'],
  runId: string,
  mode: Resolved['mode'],
) {
  const now = yield* DateTime.now
  return {
    manifest,
    sourceHash: yield* sourceHash(root),
    corpusHash: corpusHash(),
    runId,
    mode,
    createdAt: DateTime.formatIso(now),
  } satisfies Resolved
})
