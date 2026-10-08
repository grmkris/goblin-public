import { BunRuntime, BunServices } from '@effect/platform-bun'
import { Console, Effect, FileSystem, Layer, Schema } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { join, resolve } from 'node:path'
import { digest } from './artifact.ts'
import { readJson, readLedger, fail, json } from './store.ts'
import { discoverAccount, configuredProvider } from './decisions-provider.ts'
import { configured, runDecisions } from './decisions-run.ts'
import { decisionFixtures } from '../src/decisions/fixtures.ts'
import { Manifest, models } from '../src/decisions/manifest.ts'
import { questionsFor, prompt } from '../src/decisions/questions.ts'
import { plan } from '../src/decisions/runner.ts'
import { Attempt, Row } from '../src/decisions/schema.ts'
import { reportData, markdown } from '../src/decisions/report.ts'

const [command = 'plan', ...args] = Bun.argv.slice(2)
const root = resolve(import.meta.dirname, '../..')
const privateRoot = join(root, '.local/bench/decisions')
const lane = '/tmp/goblin-lanes/20261008/decisions'
const option = (name: string): string | undefined => {
  const at = args.indexOf('--' + name)
  return at < 0 ? undefined : args[at + 1]
}
const implementationHash = Effect.fn('decisions.sourceHash')(function* () {
  const fs = yield* FileSystem.FileSystem
  const scripts = (yield* fs.readDirectory(join(root, 'bench/scripts')))
    .filter((name) => name.startsWith('decisions') && name.endsWith('.ts'))
    .map((name) => 'bench/scripts/' + name)
  const source = (yield* fs.readDirectory(join(root, 'bench/src/decisions')))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => 'bench/src/decisions/' + name)
  const contents = yield* Effect.forEach(
    [...scripts, ...source, 'bench/fixtures/decisions.json', 'bun.lock'].toSorted(),
    (path) => fs.readFileString(join(root, path)).pipe(Effect.map((text) => [path, text])),
  )
  return digest(contents)
})
const status = (line: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(join(lane, 'status.md'), line + '\n', { flag: 'a' })
  }).pipe(Effect.orDie)
const steer = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = join(lane, 'steer.md')
  if (!(yield* fs.exists(path))) return
  const text = yield* fs.readFileString(path)
  if (/^(STOP|PAUSE|HOLD)\b/mu.test(text)) return yield* fail('Conductor paused the lane; preserve current run')
}).pipe(Effect.orDie)
const prepare = Effect.fn('decisions.plan')(function* () {
  const fs = yield* FileSystem.FileSystem
  const runId = option('run')
  if (runId === undefined || !/^[a-z0-9_-]+$/u.test(runId)) return yield* fail('Supply --run with a simple run id')
  const dir = join(privateRoot, runId)
  yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 })
  const account = yield* discoverAccount().pipe(
    Effect.catch(() => Effect.succeed({ account: 'unavailable', status: 0 })),
  )
  const manifest: Manifest = {
    schemaVersion: 1,
    runId,
    fixtureHash: digest(decisionFixtures),
    sourceHash: yield* implementationHash(),
    repetitions: 3,
    batchSize: 2,
    prompt,
    questions: yield* Schema.decodeUnknownEffect(Schema.JsonObject)(
      Object.fromEntries(decisionFixtures.map((fixture) => [fixture.id, questionsFor(fixture)])),
    ),
    models: models(account.account),
    limits: {
      maxRequests: 2000,
      maxUsd: 3,
      maxInput: 8_000_000,
      maxOutput: 600_000,
      perCallInput: 16_000,
      perCallOutput: 1024,
    },
  }
  const output = plan(manifest, decisionFixtures)
  if (output.requests > manifest.limits.maxRequests || output.estimatedCostUsd > manifest.limits.maxUsd)
    return yield* fail('Dry run exceeds declared budget')
  yield* fs.writeFileString(join(dir, 'manifest.json'), json(manifest), { mode: 0o600, flag: 'wx' })
  yield* fs.writeFileString(join(dir, 'dry-run.json'), json({ ...output, discoveryHttpStatus: account.status }), {
    mode: 0o600,
    flag: 'wx',
  })
  yield* status(
    'GATE dry-run ' +
      join(dir, 'manifest.json') +
      ' requests=' +
      output.requests +
      ' estimated_tokens=' +
      (output.estimatedInput + output.estimatedOutput) +
      ' estimated_USD=' +
      output.estimatedCostUsd.toFixed(6),
  )
  return { manifest: join(dir, 'manifest.json'), ...output }
})
const run = Effect.fn('decisions.command.run')(function* () {
  const path = option('manifest')
  if (path === undefined || !args.includes('--live'))
    return yield* fail('Live run requires --live --manifest after a dry run')
  const manifest = yield* readJson(resolve(path), Manifest)
  const dir = join(privateRoot, manifest.runId)
  if (resolve(path) !== join(dir, 'manifest.json'))
    return yield* fail('Manifest must live inside the named private run')
  if (manifest.fixtureHash !== digest(decisionFixtures) || manifest.sourceHash !== (yield* implementationHash()))
    return yield* fail('Source or fixtures changed; prepare a fresh manifest')
  const fs = yield* FileSystem.FileSystem
  if (!(yield* fs.exists(join(dir, 'dry-run.json')))) return yield* fail('Dry-run receipt missing')
  const result = yield* runDecisions({
    root: privateRoot,
    manifest,
    fixtures: decisionFixtures,
    provider: configuredProvider,
    available: (key) => configured(key).pipe(Effect.provide(BunServices.layer)),
    status: (line) => status(line).pipe(Effect.provide(BunServices.layer)),
    steer: steer.pipe(Effect.provide(BunServices.layer)),
  })
  return { runId: manifest.runId, halted: result.halted, skipped: result.skipped, rows: result.rows.length }
})
const report = Effect.fn('decisions.command.report')(function* () {
  const id = option('run')
  if (id === undefined || !/^[a-z0-9_-]+$/u.test(id)) return yield* fail('Supply --run with a simple run id')
  const dir = join(privateRoot, id)
  const manifest = yield* readJson(join(dir, 'manifest.json'), Manifest)
  if (manifest.fixtureHash !== digest(decisionFixtures)) return yield* fail('Fixtures differ from manifest')
  const rows = yield* readLedger(join(dir, 'results.jsonl'), Row)
  const attempts = yield* readLedger(join(privateRoot, 'attempts.jsonl'), Attempt)
  const data = reportData(manifest, decisionFixtures, rows, attempts)
  const fs = yield* FileSystem.FileSystem
  yield* fs.writeFileString(join(dir, 'report.json'), json(data), { mode: 0o600 })
  const path = join(root, 'bench/reports/decisions-' + id + '.md')
  yield* fs.makeDirectory(join(root, 'bench/reports'), { recursive: true })
  yield* fs.writeFileString(path, markdown(data))
  return { report: path, totals: data.totals }
})
const main = Effect.gen(function* () {
  yield* steer
  const result =
    command === 'plan'
      ? yield* prepare()
      : command === 'run'
        ? yield* run()
        : command === 'report'
          ? yield* report()
          : yield* fail('Use plan, run or report')
  yield* Console.log(json(result))
}).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)))
BunRuntime.runMain(main)
