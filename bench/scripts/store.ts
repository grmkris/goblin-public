import { Effect, FileSystem, Schema } from 'effect'
import { join } from 'node:path'

export class BenchError extends Schema.TaggedError<BenchError>()('BenchError', { message: Schema.String }) {}
export const fail = (message: string) => new BenchError({ message })
export const io = <A>(read: () => Promise<A>) =>
  Effect.tryPromise({ try: read, catch: () => fail('Local transport failed; inspect run traces') })
export const json = (value: unknown): string => JSON.stringify(value, null, 2)

export const readJson = Effect.fn('bench.readJson')(function* <
  S extends Schema.Top & { readonly DecodingServices: never },
>(path: string, schema: S) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(path)
  const parsed = yield* Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: () => fail(`Invalid JSON in ${path}`),
  })
  return yield* Schema.decodeUnknownEffect(schema)(parsed)
})

export const writeJson = Effect.fn('bench.writeJson')(function* (path: string, value: unknown) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.writeFileString(path, json(value), { mode: 0o600 })
})

export const appendJson = Effect.fn('bench.appendJson')(function* (path: string, value: unknown) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.writeFileString(path, `${JSON.stringify(value)}\n`, { flag: 'a', mode: 0o600 })
})

/** Bad complete ledger records fail closed. Only a torn final append is recoverable, with an explicit receipt. */
export const readLedger = Effect.fn('bench.readLedger')(function* <
  S extends Schema.Top & { readonly DecodingServices: never },
>(path: string, schema: S) {
  const fs = yield* FileSystem.FileSystem
  if (!(yield* fs.exists(path))) return []
  const text = yield* fs.readFileString(path)
  if (!text.endsWith('\n'))
    return yield* fail(`Torn ledger ${path}; preserve it and repair its final append before resuming`)
  return yield* Effect.forEach(text.split('\n').filter(Boolean), (line) => {
    const parsed = Effect.try({ try: (): unknown => JSON.parse(line), catch: () => fail(`Corrupt ledger ${path}`) })
    return parsed.pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)))
  })
})

/** Exclusive directory lock survives a crash and prevents a second coordinator from racing the same run. */
export const lockRun = Effect.fn('bench.lockRun')(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 })
  const lock = join(dir, 'coordinator.lock')
  yield* fs
    .makeDirectory(lock)
    .pipe(
      Effect.mapError(() =>
        fail(`Run is locked at ${lock}; ensure its previous coordinator has stopped before removing the lock`),
      ),
    )
  yield* Effect.addFinalizer(() => fs.remove(lock, { recursive: true }).pipe(Effect.orDie))
})
