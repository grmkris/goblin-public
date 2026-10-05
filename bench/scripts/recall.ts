import { Effect, FileSystem } from 'effect'
import { join } from 'node:path'
import { Manifest, type Scenario } from '../src/schema.ts'
import { loadCorpus } from './corpus.ts'
import { validateManifest } from '../src/manifest.ts'
import { readJson, writeJson, fail } from './store.ts'

const model = 'deepseek-v4-pro-0813'
function recallManifest(base: Manifest, scenario: Scenario, name: string, buildTrial: number): Manifest {
  return {
    ...base,
    name: name,
    split: 'development',
    profile: 'controlled',
    buildTrial: buildTrial,
    transport: { contextWindowTokens: 131072, thinking: 'provider-default', readerMaxOutputTokens: 4096 },
    variants: [
      { id: 'optchat', policy: 'optchat', writer: model, reader: model },
      { id: 'optchat-search', policy: 'optchat-search', writer: model, reader: model },
      { id: 'standard', policy: 'standard', reader: model },
      { id: 'standard-search', policy: 'standard-search', reader: model },
    ],
    pressure: { contextWindowTokens: 8192, reserveTokens: 2048, keepRecentTokens: 1024, viewBytes: 4096 },
    allowance: {
      maxAnswers: 24,
      maxRequests: 200,
      maxRequestsPerAnswer: 6,
      maxInputTokens: 1000000,
      maxOutputTokens: 50000,
      concurrency: 1,
      phases: {
        preflight: { maxRequests: 6, maxInputTokens: 50000, maxOutputTokens: 10000 },
        build: { maxRequests: 50, maxInputTokens: 400000, maxOutputTokens: 15000 },
        answer: { maxRequests: 144, maxInputTokens: 550000, maxOutputTokens: 25000 },
      },
      stages: [22, 32].map((cutoff) => ({
        cutoff,
        build: { maxRequests: 25, maxInputTokens: 200000, maxOutputTokens: 7500 },
        answer: { maxRequests: 72, maxInputTokens: 275000, maxOutputTokens: 12500 },
      })),
    },
    retrieval: { maxCalls: 4, maxBytes: 4096 },
    summaryPrompt: null,
    recallGuide: null,
    rates: [],
    preflight: {
      scenarioId: scenario.id,
      cutoff: 3,
      sourceId: scenario.events[0]?.id ?? '',
      query: 'sidebar threads',
      maxRequests: 6,
      maxInputTokens: 50000,
      maxOutputTokens: 10000,
    },
  }
}

export const createRecall = Effect.fn('bench.createRecall')(function* (
  root: string,
  options: { manifest: string; name: string; buildTrial: number },
) {
  const base = yield* readJson(options.manifest, Manifest)
  if (
    !/^[a-zA-Z0-9_.-]+$/u.test(options.name) ||
    !Number.isSafeInteger(options.buildTrial) ||
    options.buildTrial <= base.buildTrial
  )
    return yield* fail('Use a simple experiment name and fresh build-trial larger than the source manifest')
  if (base.corpus === undefined) return yield* fail('Recall v2 requires a frozen real corpus')
  const scenarios = yield* loadCorpus(root, base)
  const scenario = scenarios[0]
  const owner = scenario?.events[0]
  if (scenarios.length !== 1 || scenario === undefined || owner?.kind !== 'user')
    return yield* fail('Recall v2 requires one real session beginning with an owner request')
  const manifest = recallManifest(base, scenario, options.name, options.buildTrial)
  if (
    scenario.probes.length !== 6 ||
    [22, 32].some((cutoff) =>
      ['latest-state', 'evidence', 'abstention'].some(
        (category) =>
          scenario.probes.filter(
            (probe) => probe.cutoff === cutoff && probe.category === category && probe.label !== undefined,
          ).length !== 1,
      ),
    )
  )
    return yield* fail('Recall v2 requires the existing six reviewed real probes')
  const errors = validateManifest(manifest, scenarios)
  if (errors.length > 0) return yield* fail(errors.join('; '))
  const fs = yield* FileSystem.FileSystem
  const dir = join(root, '.local/bench/experiments')
  const path = join(dir, `${options.name}.json`)
  yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 })
  if (yield* fs.exists(path)) return yield* fail('Experiment exists; preserve it and choose a fresh name')
  yield* writeJson(path, manifest)
  return { path, answers: 24, model, stages: [22, 32], inferenceStarted: false }
})
