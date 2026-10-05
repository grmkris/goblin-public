import { Effect, FileSystem } from 'effect'
import { join } from 'node:path'
import { digest } from './artifact.ts'
export { digest, fingerprint, corpusHash, artifactIdentity } from './artifact.ts'

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
