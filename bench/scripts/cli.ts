import { BunServices, BunRuntime } from '@effect/platform-bun'
import { Console, DateTime, Effect, FileSystem, Layer, Runtime } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { join, resolve } from 'node:path'
import { plan } from '../src/plan.ts'
import { starterManifest, validateManifest } from '../src/manifest.ts'
import { Manifest } from '../src/schema.ts'
import { Resolved } from '../src/results.ts'
import { corpusHash, sourceHash } from './identity.ts'
import { ProviderConfig, validateProvider, providerCatalog } from './relay.ts'
import { readJson, fail, json, writeJson } from './store.ts'
import { run, resolveRun, loadRun } from './runner.ts'
import { compare, renderReport, promotion } from '../src/report.ts'

const [command = 'plan', ...args] = Bun.argv.slice(2)
function option(name: string): string | undefined {
  const at = args.indexOf(`--${name}`)
  return at < 0 ? undefined : args[at + 1]
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
    return { mode: 'fake', configured: false, models: manifest.variants.map((variant) => variant.reader) }
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
  const now = yield* DateTime.now
  const id = runId ?? `run-${DateTime.formatIso(now).replaceAll(/[^0-9]/gu, '')}`
  const dir = runDir(id)
  const resolved =
    command === 'resume'
      ? yield* readJson(join(dir, 'resolved.json'), Resolved)
      : yield* resolveRun(root, manifest, id, args.includes('--live') ? 'live' : 'fake')
  if (resolved.sourceHash !== (yield* sourceHash(root)) || resolved.corpusHash !== corpusHash())
    return yield* fail('Current source or corpus differs from this run; start a new run')
  if (command === 'resume' && resolved.mode === 'live' && !args.includes('--live'))
    return yield* fail('Resuming live inference requires --live')
  return yield* run({
    root,
    dir,
    resolved,
    resume: command === 'resume',
    ...(option('provider') === undefined ? {} : { providerPath: option('provider') ?? '' }),
  })
})

const analyze = Effect.fn('bench.analyze')(function* () {
  const data = yield* loadRun(runDir(runId))
  if (command === 'report') {
    const fs = yield* FileSystem.FileSystem
    const path = join(runDir(runId), 'report.html')
    yield* fs.writeFileString(path, renderReport(data), { mode: 0o600 })
    return { path }
  }
  if (command === 'compare') return compare(data, yield* loadRun(runDir(option('against'))))
  if (command === 'promote') {
    const incumbent = yield* loadRun(runDir(option('against')))
    const decision = promotion(data, incumbent)
    if (!decision.eligible) return decision
    const path = join(root, '.local/bench/incumbent.json')
    yield* writeJson(path, { runId: data.resolved.runId, resolved: data.resolved, decision })
    return { ...decision, path }
  }
  return yield* fail('Use compare, report or promote')
})

const program = Effect.gen(function* () {
  const manifest =
    option('manifest') === undefined ? starterManifest() : yield* readJson(resolve(option('manifest') ?? ''), Manifest)
  const errors = validateManifest(manifest)
  if (errors.length > 0) return yield* fail(errors.join('; '))
  switch (command) {
    case 'plan':
      return plan(manifest)
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
