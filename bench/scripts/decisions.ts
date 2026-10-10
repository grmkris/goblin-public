import { BunRuntime, BunServices } from '@effect/platform-bun'
import { Console, Effect, FileSystem, Layer, Schema } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { join, resolve } from 'node:path'
import { digest } from './artifact.ts'
import { readJson, readLedger, fail, json } from './store.ts'
import { discoverAccount, configuredProvider } from './decisions-provider.ts'
import { configured, runDecisions } from './decisions-run.ts'
import { defaultFixtureFile, decodeFixtures } from '../src/decisions/fixtures.ts'
import { Manifest, models, freezeThresholds } from '../src/decisions/manifest.ts'
import { questionsFor, prompt } from '../src/decisions/questions.ts'
import { plan } from '../src/decisions/runner.ts'
import { Attempt, Row, arms } from '../src/decisions/schema.ts'
import { reportData, markdown, combineRows } from '../src/decisions/report.ts'
import { totals } from '../src/decisions/budget.ts'
import { settleUnfinished } from './decisions-settle.ts'

const [command = 'plan', ...args] = Bun.argv.slice(2)
const root = resolve(import.meta.dirname, '../..')
const privateRoot = join(root, '.local/bench/decisions')
const lane = '/tmp/goblin-lanes/20261009/x'
const option = (name: string): string | undefined => {
  const at = args.indexOf('--' + name)
  return at < 0 ? undefined : args[at + 1]
}
const fixtureFileForOption = (value: string | undefined): string => {
  if (value === undefined || value === 'dev') return defaultFixtureFile
  if (value === 'heldout') return 'bench/fixtures/decisions-heldout.json'
  if (/^bench\/fixtures\/decisions-[a-z0-9_-]+\.json$/u.test(value)) return value
  throw new Error('Fixtures must be dev, heldout or a bench/fixtures decisions JSON path')
}
const loadFixtures = Effect.fn('decisions.loadFixtures')(function* (fixtureFile: string) {
  const fs = yield* FileSystem.FileSystem
  fixtureFileForOption(fixtureFile === defaultFixtureFile ? 'dev' : fixtureFile)
  const text = yield* fs.readFileString(join(root, fixtureFile))
  return decodeFixtures(JSON.parse(text))
})
const implementationHash = Effect.fn('decisions.sourceHash')(function* (fixtureFile: string) {
  const fs = yield* FileSystem.FileSystem
  const scripts = (yield* fs.readDirectory(join(root, 'bench/scripts')))
    .filter((name) => name.startsWith('decisions') && name.endsWith('.ts'))
    .map((name) => 'bench/scripts/' + name)
  const source = (yield* fs.readDirectory(join(root, 'bench/src/decisions')))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => 'bench/src/decisions/' + name)
  const runtime = ['schema.ts', 'questions.ts', 'wire.ts', 'rules.ts'].map(
    (name) => 'apps/runtime/src/decisions/' + name,
  )
  const contents = yield* Effect.forEach(
    [...scripts, ...source, ...runtime, fixtureFile, 'bun.lock'].toSorted(),
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
const frozenThresholds = Effect.fn('decisions.frozenThresholds')(function* (fixtureFile: string) {
  const id = option('thresholds-from')
  if (id === undefined) {
    if (fixtureFile !== defaultFixtureFile)
      return yield* fail('Independent fixtures require --thresholds-from a development run')
    return {}
  }
  if (!/^[a-z0-9_-]+$/u.test(id)) return yield* fail('Invalid threshold source run id')
  const data = yield* readJson(
    join(privateRoot, id, 'report.json'),
    Schema.Struct({
      metrics: Schema.Array(
        Schema.Struct({
          task: Schema.String,
          arm: Schema.String,
          threshold: Schema.NullOr(Schema.Struct({ value: Schema.Number })),
        }),
      ),
    }),
  )
  return { thresholdSource: id, frozenThresholds: freezeThresholds(data.metrics) }
})
const exclusions = Effect.fn('decisions.exclusions')(function* (fixtureHash: string) {
  const sourceId = option('exclude-from')
  if (sourceId === undefined) return {}
  if (!/^[a-z0-9_-]+$/u.test(sourceId)) return yield* fail('Invalid exclusion source')
  const dir = join(privateRoot, sourceId)
  const prior = yield* readJson(join(dir, 'manifest.json'), Manifest)
  if (prior.fixtureHash !== fixtureHash) return yield* fail('Exclusion fixtures differ')
  const rows = yield* readLedger(join(dir, 'results.jsonl'), Row)
  return { excludeRows: rows.map(({ id, arm, repetition }) => ({ id, arm, repetition })) }
})
const createManifest = Effect.fn('decisions.createManifest')(function* (runId: string, fixtureFile: string) {
  const fixtures = yield* loadFixtures(fixtureFile)
  const account = yield* discoverAccount().pipe(
    // expected: the manifest records an account it could not discover as `unavailable`
    Effect.catch(() => Effect.succeed({ account: 'unavailable', status: 0 })),
  )
  const manifest: Manifest = {
    schemaVersion: 1,
    runId,
    fixtureFile,
    ...(yield* frozenThresholds(fixtureFile)),
    fixtureHash: digest(fixtures),
    ...(yield* exclusions(digest(fixtures))),
    ...(option('campaign') === undefined ? {} : { campaign: { id: option('campaign') ?? '', maxUsd: 3.5 } }),
    sourceHash: yield* implementationHash(fixtureFile),
    repetitions: 3,
    batchSize: 2,
    selectedArms: yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Literals(arms)))(
      option('arms')?.split(',') ?? arms,
    ),
    prompt,
    questions: yield* Schema.decodeUnknownEffect(Schema.JsonObject)(
      Object.fromEntries(fixtures.map((fixture) => [fixture.id, questionsFor(fixture)])),
    ),
    models: models(account.account),
    limits: {
      maxRequests: 2000,
      maxUsd: 3,
      maxInput: 8_000_000,
      maxOutput: 2_000_000,
      perCallInput: 16_000,
      perCallOutput: 1024,
    },
  }
  return { manifest, fixtures, discoveryHttpStatus: account.status }
})
const prepare = Effect.fn('decisions.plan')(function* () {
  const fs = yield* FileSystem.FileSystem
  const runId = option('run')
  if (runId === undefined || !/^[a-z0-9_-]+$/u.test(runId)) return yield* fail('Supply --run with a simple run id')
  const dir = join(privateRoot, runId)
  const { manifest, fixtures, discoveryHttpStatus } = yield* createManifest(
    runId,
    fixtureFileForOption(option('fixtures')),
  )
  yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 })
  const output = plan(manifest, fixtures)
  const records = yield* readLedger(join(privateRoot, 'attempts.jsonl'), Attempt)
  const retained = totals(
    manifest.campaign === undefined ? records : records.filter((record) => record.campaignId === manifest.campaign?.id),
  )
  if (
    output.requests > manifest.limits.maxRequests ||
    output.maximumReservedUsd > manifest.limits.maxUsd ||
    output.maximumReservedUsd + retained.usd > (manifest.campaign?.maxUsd ?? manifest.limits.maxUsd)
  )
    return yield* fail('Dry run exceeds declared budget')
  yield* fs.writeFileString(join(dir, 'manifest.json'), json(manifest), { mode: 0o600, flag: 'wx' })
  yield* fs.writeFileString(join(dir, 'dry-run.json'), json({ ...output, retained, discoveryHttpStatus }), {
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
  return { manifest: join(dir, 'manifest.json'), ...output, retained }
})
const run = Effect.fn('decisions.command.run')(function* () {
  const path = option('manifest')
  if (path === undefined || !args.includes('--live'))
    return yield* fail('Live run requires --live --manifest after a dry run')
  const manifest = yield* readJson(resolve(path), Manifest)
  const dir = join(privateRoot, manifest.runId)
  if (resolve(path) !== join(dir, 'manifest.json'))
    return yield* fail('Manifest must live inside the named private run')
  const fixtures = yield* loadFixtures(manifest.fixtureFile ?? defaultFixtureFile)
  if (
    manifest.fixtureHash !== digest(fixtures) ||
    manifest.sourceHash !== (yield* implementationHash(manifest.fixtureFile ?? defaultFixtureFile))
  )
    return yield* fail('Source or fixtures changed; prepare a fresh manifest')
  const fs = yield* FileSystem.FileSystem
  if (!(yield* fs.exists(join(dir, 'dry-run.json')))) return yield* fail('Dry-run receipt missing')
  const result = yield* runDecisions({
    root: privateRoot,
    manifest,
    fixtures,
    provider: configuredProvider,
    available: (key) => configured(key).pipe(Effect.provide(BunServices.layer)),
    status: (line) => status(line).pipe(Effect.provide(BunServices.layer)),
    steer: steer.pipe(Effect.provide(BunServices.layer)),
  })
  return { runId: manifest.runId, halted: result.halted, skipped: result.skipped, rows: result.rows.length }
})
const includedRun = Effect.fn('decisions.includedRun')(function* (manifest: Manifest, id: string) {
  if (!/^[a-z0-9_-]+$/u.test(id) || id === manifest.runId) return yield* fail('Invalid included run')
  const dir = join(privateRoot, id)
  const prior = yield* readJson(join(dir, 'manifest.json'), Manifest)
  const compatible =
    prior.fixtureHash === manifest.fixtureHash &&
    prior.prompt === manifest.prompt &&
    digest(prior.questions) === digest(manifest.questions)
  if (!compatible) return yield* fail('Included run has incompatible evidence or model definitions')
  const rows = yield* readLedger(join(dir, 'results.jsonl'), Row)
  const matchingArms = new Set(
    prior.models
      .filter((model) => manifest.models.some((current) => digest(model) === digest(current)))
      .map((model) => model.arm),
  )
  return {
    manifest: prior,
    rows: rows.filter((row) => row.route === 'rules' || matchingArms.has(row.arm === 'critic' ? 'clef' : row.arm)),
  }
})
const report = Effect.fn('decisions.command.report')(function* () {
  const id = option('run')
  if (id === undefined || !/^[a-z0-9_-]+$/u.test(id)) return yield* fail('Supply --run with a simple run id')
  const dir = join(privateRoot, id)
  const manifest = yield* readJson(join(dir, 'manifest.json'), Manifest)
  const fixtures = yield* loadFixtures(manifest.fixtureFile ?? defaultFixtureFile)
  if (manifest.fixtureHash !== digest(fixtures)) return yield* fail('Fixtures differ from manifest')
  const rows = yield* readLedger(join(dir, 'results.jsonl'), Row)
  const attempts = yield* readLedger(join(privateRoot, 'attempts.jsonl'), Attempt)
  const prior = yield* Effect.forEach(option('include')?.split(',') ?? [], (runId) => includedRun(manifest, runId))
  const combined = combineRows([...prior.map((item) => item.rows), rows])
  const data = reportData(manifest, fixtures, combined, attempts, [...prior.map((item) => item.manifest), manifest])
  const fs = yield* FileSystem.FileSystem
  yield* fs.writeFileString(join(dir, 'report.json'), json(data), { mode: 0o600 })
  const path = join(root, 'bench/reports/decisions-' + id + '.md')
  yield* fs.makeDirectory(join(root, 'bench/reports'), { recursive: true })
  yield* fs.writeFileString(path, markdown(data))
  return { report: path, totals: data.totals }
})
const settleCommand = Effect.fn('decisions.command.settle')(function* () {
  const runId = option('run')
  const attemptId = option('attempt')
  if (runId === undefined || attemptId === undefined) return yield* fail('Supply --run and --attempt')
  return yield* settleUnfinished({ root: privateRoot, runId, attemptId, ownerApproved: option('owner-approved') })
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
          : command === 'settle-unfinished'
            ? yield* settleCommand()
            : yield* fail('Use plan, run, report or settle-unfinished')
  yield* Console.log(json(result))
}).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)))
BunRuntime.runMain(main)
