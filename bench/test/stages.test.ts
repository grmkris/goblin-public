import { FetchHttpClient } from 'effect/http'
import { Effect, FileSystem, Layer, Schema } from 'effect'
import { expect, test } from 'vitest'
import { dataset } from '../src/fixtures.ts'
import { starterManifest } from '../src/manifest.ts'
import { episodes } from '../src/plan.ts'
import { failedScore } from '../src/evaluate.ts'
import { stageAdmission, stageGate, type StageReceipt } from '../src/stages.ts'
import { Resolved, type RunData, type Trace } from '../src/results.ts'
import { run } from '../scripts/runner.ts'

function staged(): RunData {
  const scenario = dataset()[0]
  if (scenario === undefined) throw new Error('Missing harness fixture')
  const probes = scenario.probes.slice(0, 2).map((probe, index) => ({ ...probe, cutoff: index === 0 ? 22 : 32 }))
  const limits = { maxRequests: 10, maxInputTokens: 1000, maxOutputTokens: 100 }
  const manifest = {
    ...starterManifest(),
    scenarioIds: [scenario.id],
    variants: starterManifest().variants.slice(0, 1),
    allowance: {
      ...starterManifest().allowance,
      maxRequestsPerAnswer: 6,
      phases: { preflight: limits, build: limits, answer: limits },
      stages: [22, 32].map((cutoff) => ({
        cutoff,
        build: { ...limits, maxRequests: 5, maxInputTokens: 500, maxOutputTokens: 50 },
        answer: { ...limits, maxRequests: 5, maxInputTokens: 500, maxOutputTokens: 50 },
      })),
    },
  }
  return {
    resolved: {
      manifest,
      scenarios: [{ ...scenario, probes }],
      runId: 'stage-test',
      sourceHash: 'source',
      corpusHash: 'corpus',
      createdAt: '',
      mode: 'fake',
    },
    traces: [],
    results: [],
  }
}
function completed(data: RunData, cutoff: number): RunData {
  return {
    ...data,
    results: episodes(data.resolved.manifest, data.resolved.scenarios)
      .filter((episode) => episode.probe.cutoff <= cutoff)
      .map((episode) => ({
        id: episode.id,
        variant: episode.variant.id,
        category: episode.probe.category,
        status: 'completed',
        answer: null,
        score: failedScore,
        malformed: true,
        futureLeakage: false,
        unauthorizedReads: false,
        forbiddenEndorsement: false,
        deliveredIds: [],
        detail: 'Poor answer quality must not block operational advancement',
      })),
  }
}
function receipt(data: RunData, cutoff: number): StageReceipt {
  return {
    ...stageGate(data, cutoff),
    runId: data.resolved.runId,
    sourceHash: data.resolved.sourceHash,
    corpusHash: data.resolved.corpusHash,
    cutoff,
    at: '',
  }
}
function trace(data: RunData): Trace {
  const episode = episodes(data.resolved.manifest, data.resolved.scenarios)[0]
  return {
    attempt: 1,
    scope: `${data.resolved.runId}.${episode?.id}`,
    phase: 'answer',
    stage: 22,
    model: 'glm-5.3',
    status: 200,
    input: 20,
    output: 10,
    unknownUsage: false,
    request: '',
    response: '',
    at: '',
  }
}

test('first stage defaults to 22; advancing requires a matching durable operational gate', () => {
  const initial = staged()
  expect(stageAdmission(initial, [], undefined)).toEqual({ cutoff: 22, reasons: [] })
  expect(stageAdmission(initial, [], 32).reasons).toContain('Previous stage must pass its durable operational gate')
  const data = completed(initial, 22)
  expect(stageAdmission(data, [receipt(data, 22)], 32).reasons).toEqual([])
  expect(stageAdmission(data, [{ ...receipt(data, 22), sourceHash: 'foreign' }], 32).reasons).toContain(
    'Stage receipt identity mismatch',
  )
  expect(stageAdmission(data, [{ ...receipt(data, 22), cutoff: 32 }], 22).reasons).toContain(
    'Stage cannot move backwards',
  )
  expect(stageAdmission(data, [], 30).reasons).toContain('Select a configured --until-cutoff')
})

test('unknown usage, overrun, unfinished work and failed stages fail closed', () => {
  const data = completed(staged(), 22)
  const record = trace(data)
  const unknown = { ...data, traces: [{ ...record, unknownUsage: true }] }
  expect(stageGate(unknown, 22).passed).toBe(false)
  expect(stageAdmission(unknown, [receipt(unknown, 22)], 22).reasons).toContain(
    'Failed stage is preserved; start a fresh named trial',
  )
  expect(stageGate({ ...data, traces: [{ ...record, reservedOutput: 1 }] }, 22).reasons).toContain(
    'Provider reservation breach',
  )
  expect(
    stageGate({ ...data, traces: Array.from({ length: 7 }, (_, index) => ({ ...record, attempt: index + 1 })) }, 22)
      .reasons,
  ).toContain('Per-answer request ceiling exceeded')
  expect(stageAdmission({ ...data, results: [], traces: [record] }, [], 22).reasons).toContain(
    'Unfinished answer evidence is preserved; start a fresh named trial',
  )
})

test('completed no-op resume never opens a provider or local stack', async () => {
  const data = completed(staged(), 22)
  const resolved = Schema.decodeUnknownSync(Resolved)(data.resolved)
  const files = new Map<string, string>([
    ['run/resolved.json', JSON.stringify(resolved)],
    ...data.results.map((result) => [`run/episodes/${result.id}.json`, JSON.stringify(result)] as const),
    ['run/stages.jsonl', `${JSON.stringify(receipt(data, 22))}\n`],
  ])
  const fs = FileSystem.layerNoop({
    exists: (path) => Effect.succeed(files.has(path)),
    makeDirectory: () => Effect.void,
    remove: () => Effect.void,
    readDirectory: () => Effect.succeed(data.results.map((result) => `${result.id}.json`)),
    readFileString: (path) => Effect.succeed(files.get(path) ?? ''),
    writeFileString: (path, content) =>
      Effect.sync(() => {
        files.set(path, content)
      }),
  })
  const outcome = await Effect.runPromise(
    Effect.scoped(run({ root: '.', dir: 'run', resolved, resume: true })).pipe(
      Effect.provide(Layer.merge(fs, FetchHttpClient.layer)),
    ),
  )
  expect(outcome.answers).toBe(1)
})
