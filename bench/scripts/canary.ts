import { Effect, FileSystem, Schema } from 'effect'
import { join } from 'node:path'
import { Corpus } from '../src/corpus.ts'
import { validateScenario } from '../src/fixtures.ts'
import { starterManifest, validateManifest } from '../src/manifest.ts'
import { Probe } from '../src/schema.ts'
import { fail, readJson, writeJson } from './store.ts'
import { sha256 } from './corpus.ts'

/** Build a frozen six-arm live manifest from reviewed prefix probes, never from generated questions or answers. */
export const createCanary = Effect.fn('bench.createCanary')(function* (root: string, id: string, labelsPath: string) {
  if (!/^[a-zA-Z0-9_.-]+$/u.test(id)) return yield* fail('Supply a simple corpus ID')
  const dir = join(root, '.local/bench/corpora', id)
  const fs = yield* FileSystem.FileSystem
  const path = join(dir, 'labeled.json')
  if (yield* fs.exists(path)) return yield* fail('Labeled corpus already exists; preserve it and use its manifest')
  const corpus = yield* readJson(join(dir, 'corpus.json'), Corpus)
  const probes = yield* readJson(labelsPath, Schema.Array(Probe))
  const original = corpus.scenarios[0]
  if (original === undefined || corpus.scenarios.length !== 1) return yield* fail('Canary requires one real session')
  const cutoffs = corpus.checkpoints.map((checkpoint) => checkpoint.cutoff)
  if (probes.length !== 6 || probes.some((probe) => probe.label === undefined || !cutoffs.includes(probe.cutoff)))
    return yield* fail('Canary requires six labeled probes at the imported cutoffs')
  for (const cutoff of cutoffs) {
    const categories = probes
      .filter((probe) => probe.cutoff === cutoff)
      .map((probe) => probe.category)
      .toSorted()
    if (JSON.stringify(categories) !== JSON.stringify(['abstention', 'evidence', 'latest-state']))
      return yield* fail('Each cutoff requires state, evidence and abstention probes')
  }
  const scenario = { ...original, probes }
  const starter = starterManifest()
  const relative = `.local/bench/corpora/${id}/labeled.json`
  const labeled = { ...corpus, scenarios: [scenario] }
  const text = `${JSON.stringify(labeled, null, 2)}\n`
  const manifest = {
    ...starter,
    name: `real-${id}`,
    scenarioIds: [scenario.id],
    corpus: { path: relative, sha256: sha256(text) },
    variants: starter.variants.filter((variant) => variant.policy !== 'optchat' || variant.writer === variant.reader),
    allowance: { ...starter.allowance, maxAnswers: 36, concurrency: 1 },
  }
  const errors = [...validateScenario(scenario), ...validateManifest(manifest, [scenario])]
  if (errors.length > 0) return yield* fail(errors.join('; '))
  yield* fs.writeFileString(path, text, { mode: 0o600 })
  yield* writeJson(join(dir, 'manifest.json'), manifest)
  return { manifest: join(dir, 'manifest.json'), corpusHash: manifest.corpus.sha256, answers: 36 }
})
