import { Config, Effect, FileSystem, Redacted, Schema } from 'effect'
import { createHash } from 'node:crypto'
import { join, resolve, sep } from 'node:path'
import { Corpus } from '../src/corpus.ts'
import { dataset } from '../src/fixtures.ts'
import { importClaude, sourceCheckpoints } from '../src/import.ts'
import { redactor } from './redaction.ts'
import type { Manifest } from '../src/schema.ts'
import { fail, readJson, writeJson } from './store.ts'

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

export const loadCorpus = Effect.fn('bench.loadCorpus')(function* (root: string, manifest: Manifest) {
  if (manifest.corpus === undefined) return dataset()
  const fs = yield* FileSystem.FileSystem
  const base = join(root, '.local/bench/corpora')
  const path = yield* fs.realPath(resolve(root, manifest.corpus.path))
  if (!path.startsWith(`${base}${sep}`)) return yield* fail('Real corpora must be private under .local/bench/corpora')
  if (((yield* fs.stat(path)).mode & 0o077) !== 0) return yield* fail('Corpus must be mode 600')
  const text = yield* fs.readFileString(path)
  if (sha256(text) !== manifest.corpus.sha256) return yield* fail('Corpus hash mismatch')
  const corpus = yield* readJson(path, Corpus)
  if (
    corpus.scenarios.some(
      (scenario) => scenario.probes.length === 0 || scenario.probes.some((probe) => probe.label === undefined),
    )
  )
    return yield* fail('Real corpora require audited prefix labels before execution')
  return corpus.scenarios
})

/** Private local tooling: environment credential values are used only as redaction literals. */
export const importCorpus = Effect.fn('bench.importCorpus')(function* (root: string, sourcePath: string, id: string) {
  if (!/^[a-zA-Z0-9_.-]+$/u.test(id)) return yield* fail('Supply a simple corpus ID')
  const fs = yield* FileSystem.FileSystem
  const dir = join(root, '.local/bench/corpora', id)
  if (yield* fs.exists(dir)) return yield* fail('Corpus already exists; use a new ID to preserve the frozen source')
  const source = yield* fs.readFileString(sourcePath)
  const names = [...source.matchAll(/\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\b/gu)].map(
    (match) => match[0],
  )
  names.push('CLIPROXY_API_KEY', 'CLOUDFLARE_API_TOKEN', 'LITELLM_MASTER_KEY_RAILWAY')
  const credentials = yield* Config.all(
    [...new Set(names)].map((name) => Config.Redacted(name).pipe(Config.withDefault(Redacted.make('')))),
  )

  const redaction = redactor(credentials.map(Redacted.value))
  const imported = yield* Effect.try({
    try: () => importClaude(source, redaction.redact),
    catch: () => fail('Source import failed; malformed, unsupported, or unmatched source records'),
  })
  const checkpoints = yield* Effect.try({
    try: () => sourceCheckpoints(imported.events, [16_000, 32_000]),
    catch: () => fail('Source lacks complete 16k/32k checkpoints'),
  })
  const corpus = yield* Schema.decodeUnknownEffect(Corpus)({
    schemaVersion: 1,
    id,
    kind: 'claude-jsonl',
    sourceHash: sha256(source),
    redactedHash: sha256(JSON.stringify(imported.events)),
    sourceLines: imported.lines,
    compactBoundaries: imported.boundaries,
    omissions: imported.omissions,
    checkpoints,
    scenarios: [{ id, family: id, split: 'development', events: imported.events, probes: [] }],
  })
  yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 })
  // Snapshot and map never leave the private host corpus directory.
  yield* fs.writeFileString(join(dir, 'source.jsonl'), source, { mode: 0o600 })
  yield* writeJson(join(dir, 'redaction-map.json'), redaction.mapping())
  yield* writeJson(join(dir, 'corpus.json'), corpus)
  return {
    id,
    dir,
    sourceHash: corpus.sourceHash,
    events: imported.events.length,
    checkpoints,
    redactions: redaction.mapping().length,
    omissions: imported.omissions.length,
    labelsRequired: true,
  }
})
