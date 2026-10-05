import { Effect, FileSystem } from 'effect'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { dataset } from '../src/fixtures.ts'
import { publicEvents } from '../src/protocol.ts'
import type { Resolved } from '../src/results.ts'
import type { Scenario, Variant } from '../src/schema.ts'

export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const corpusHash = (scenarios: readonly Scenario[] = dataset()): string => digest(scenarios)
export const sourceHash = Effect.fn('bench.sourceHash')(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const files: string[] = []
  const collect = (dir: string): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      for (const name of yield* fs.readDirectory(join(root, dir))) {
        const path = join(dir, name)
        const stat = yield* fs.stat(join(root, path))
        if (stat.type === 'Directory') yield* collect(path)
        else if (name.endsWith('.ts')) files.push(path)
      }
    })
  for (const dir of [
    'bench/src',
    'bench/worker',
    'bench/scripts',
    'apps/runtime/src/memory',
    'apps/runtime/src/pi',
    'apps/runtime/src/storage',
  ])
    yield* collect(dir)
  files.push('bun.lock')
  const content = yield* Effect.forEach(files.toSorted(), (file) =>
    fs.readFileString(join(root, file)).pipe(Effect.map((text) => [file, text])),
  )
  return digest(content)
})

/** Reader-independent OptChat builds, coupled native writers, and shared search/standard compaction roots. */
export function artifactIdentity(resolved: Resolved, scenarioId: string, variant: Variant): string {
  const scenario = (resolved.scenarios ?? dataset()).find((item) => item.id === scenarioId)
  return digest({
    source: resolved.sourceHash,
    corpus: scenario === undefined ? '' : publicEvents(scenario.events),
    mode: resolved.mode,
    policy: variant.policy === 'optchat' ? 'optchat' : 'standard',
    writer: variant.writer ?? variant.reader,
    profile: resolved.manifest.profile,
    pressure: resolved.manifest.pressure,
    trial: resolved.manifest.buildTrial,
    prompt: resolved.manifest.summaryPrompt,
  })
}
