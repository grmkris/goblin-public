import { BunServices, BunRuntime } from '@effect/platform-bun'
import { Console, DateTime, Effect, FileSystem, Layer, Runtime } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { join, resolve } from 'node:path'
import { createCanary } from './canary.ts'
import { recordReviews } from './review.ts'
import { importCorpus, loadCorpus } from './corpus.ts'
import { plan } from '../src/plan.ts'
import { starterManifest, validateManifest } from '../src/manifest.ts'
import { Manifest } from '../src/schema.ts'
import { paired } from '../src/paired.ts'
import { Resolved } from '../src/results.ts'
import { corpusHash, sourceHash } from './identity.ts'
import { ProviderConfig, validateProvider, providerCatalog } from './relay.ts'
import { readJson, fail, json, writeJson, appendJson, lockRun } from './store.ts'
import { Schema } from 'effect'
import { run, resolveRun, loadRun } from './runner.ts'
import { compare, renderReport, promotion, accounting, summary, phaseAccounting } from '../src/report.ts'
import { efficiency } from '../src/metrics.ts'
import { createRecall } from './recall.ts'

const [command = 'plan', ...args] = Bun.argv.slice(2)
function option(name: string): string | undefined {
  const at = args.indexOf(`--${name}`)
  return at < 0 ? undefined : args[at + 1]
}
function cutoffOption(): number {
  const value = Number(option('until-cutoff'))
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Supply a positive integer --until-cutoff')
  return value
}
const root = resolve(import.meta.dirname, '../..')
const runs = join(root, '.local/bench/runs')
const runId = option('run')
function runDir(id: string | undefined): string {
  if (id === undefined || !/^[a-zA-Z0-9_.-]+$/u.test(id)) throw new Error('Supply --run with a simple run name')
  return join(runs, id)
}

const doctor = Effect.fn('bench.doctor')(function* (manifest: Manifest) {
  const fs = yield* FileSystem.FileSystem
  const providerPath = option('provider') ?? join(root, '.local/bench/provider.json')
  const configured = yield* fs.exists(providerPath)
  if (!configured)
    return { mode: 'fake', configured: false, models: [...new Set(manifest.variants.map((variant) => variant.reader))] }
  const provider = yield* readJson(providerPath, ProviderConfig)
  yield* validateProvider(providerPath, provider)
  const catalog = yield* providerCatalog(provider)
  const wanted = [
    ...new Set(manifest.variants.flatMap((variant) => [variant.reader, variant.writer ?? variant.reader])),
  ]
  return {
    configured: true,
    models: wanted.map((id) => ({ id, offered: catalog.includes(id) })),
    inferenceVerified: false,
  }
})

const executeRun = Effect.fn('bench.command.run')(function* (manifest: Manifest) {
  if (command === 'run' && args.includes('--live') && option('manifest') === undefined)
    return yield* fail('Live runs require an explicit --manifest; review bench:plan first')
  const now = yield* DateTime.now
  const id = runId ?? `run-${DateTime.formatIso(now).replaceAll(/[^0-9]/gu, '')}`
  const dir = runDir(id)
  const resolved =
    command === 'resume'
      ? yield* readJson(join(dir, 'resolved.json'), Resolved)
      : yield* resolveRun(root, manifest, id, args.includes('--live') ? 'live' : 'fake')
  if (
    resolved.sourceHash !== (yield* sourceHash(root)) ||
    resolved.corpusHash !== corpusHash(yield* loadCorpus(root, resolved.manifest))
  )
    return yield* fail('Current source or corpus differs from this run; start a new run')
  if (resolved.scenarios !== undefined && corpusHash(resolved.scenarios) !== resolved.corpusHash)
    return yield* fail('Resolved corpus snapshot was modified')
  if (command === 'resume' && resolved.mode === 'live' && !args.includes('--live'))
    return yield* fail('Resuming live inference requires --live')
  return yield* run({
    root,
    dir,
    resolved,
    resume: command === 'resume',
    ...(option('until-cutoff') === undefined ? {} : { untilCutoff: cutoffOption() }),
    ...(option('provider') === undefined ? {} : { providerPath: option('provider') ?? '' }),
  })
})

const analyze = Effect.fn('bench.analyze')(function* () {
  const data = yield* loadRun(runDir(runId))
  if (command === 'report') {
    const fs = yield* FileSystem.FileSystem
    const path = join(runDir(runId), 'report.html')
    yield* fs.writeFileString(path, renderReport(data), { mode: 0o600 })
    yield* writeJson(join(runDir(runId), 'report.json'), {
      scores: summary(data),
      accounting: accounting(data),
      phases: phaseAccounting(data),
      efficiency: efficiency(data),
      paired: paired(data),
    })
    return { path, paired: paired(data).map(({ rows: _rows, ...decision }) => decision) }
  }
  if (command === 'compare') return compare(data, yield* loadRun(runDir(option('against'))))
  if (command === 'promote') {
    yield* lockRun(join(root, '.local/bench/promotion'))
    const incumbent = yield* loadRun(runDir(option('against')))
    const decision = promotion(data, incumbent)
    if (!decision.eligible) return decision
    const path = join(root, '.local/bench/incumbent.json')
    const fs = yield* FileSystem.FileSystem
    if (yield* fs.exists(path)) {
      const frozen = yield* readJson(path, Schema.Struct({ runId: Schema.String }))
      if (frozen.runId !== incumbent.resolved.runId)
        return yield* fail('The frozen incumbent changed; compare against its current run')
    }
    yield* appendJson(join(root, '.local/bench/promotions.jsonl'), {
      resolved: data.resolved,
      against: incumbent.resolved.runId,
      decision,
    })
    yield* writeJson(path, { runId: data.resolved.runId, resolved: data.resolved, decision })
    return { ...decision, path }
  }
  return yield* fail('Use compare, report or promote')
})

const artifactCommand = Effect.fn('bench.artifactCommand')(function* () {
  if (command === 'recall')
    return yield* createRecall(root, {
      manifest: resolve(option('manifest') ?? ''),
      name: option('name') ?? 'deepseek-recall-v2',
      buildTrial: Number(option('build-trial')),
    })
  if (command === 'canary') return yield* createCanary(root, option('corpus') ?? '', resolve(option('labels') ?? ''))
  if (command === 'review') return yield* recordReviews(runDir(runId), resolve(option('review') ?? ''))
  if (command === 'import') return yield* importCorpus(root, resolve(option('source') ?? ''), option('corpus') ?? '')
  if (['report', 'compare', 'promote'].includes(command)) return yield* analyze()
  return yield* fail('Unknown artifact command')
})
const program = Effect.gen(function* () {
  if (['recall', 'canary', 'review', 'import', 'report', 'compare', 'promote'].includes(command))
    return yield* artifactCommand()
  const manifest =
    option('manifest') === undefined ? starterManifest() : yield* readJson(resolve(option('manifest') ?? ''), Manifest)
  const scenarios = yield* loadCorpus(root, manifest)
  const errors = validateManifest(manifest, scenarios)
  if (errors.length > 0) return yield* fail(errors.join('; '))
  switch (command) {
    case 'plan':
      return plan(manifest, scenarios)
    case 'validate':
      return { errors }
    case 'doctor':
      return yield* doctor(manifest)
    case 'run':
    case 'resume':
      return yield* executeRun(manifest)
    case 'report':
    case 'compare':
    case 'promote':
      return yield* analyze()
    default:
      return yield* fail('Use doctor, plan, validate, run, resume, compare, report or promote')
  }
})

BunRuntime.runMain(
  Effect.scoped(program).pipe(
    Effect.tap((result) => Console.log(json(result))),
    Effect.provide(Layer.merge(BunServices.layer, FetchHttpClient.layer)),
  ),
  { teardown: (exit) => Runtime.defaultTeardown(exit, (code) => process.exit(code)) },
)
