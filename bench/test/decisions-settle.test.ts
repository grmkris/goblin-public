import { Effect, FileSystem } from 'effect'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { settleUnfinished } from '../scripts/decisions-settle.ts'
import type { Attempt } from '../src/decisions/schema.ts'
import { admission, totals } from '../src/decisions/budget.ts'
import { models, type Manifest } from '../src/decisions/manifest.ts'

const files = FileSystem.layerNoop({
  exists: (path) =>
    Effect.promise(async () => {
      try {
        await access(path)
        return true
      } catch {
        // expected: a path that cannot be reached does not exist, as the real file system answers
        return false
      }
    }),
  readFileString: (path) => Effect.promise(() => readFile(path, 'utf8')),
  writeFileString: (path, text, options) => Effect.promise(() => writeFile(path, text, options)),
  makeDirectory: (path, options) => Effect.promise(() => mkdir(path, options)).pipe(Effect.asVoid),
  remove: (path, options) => Effect.promise(() => rm(path, options)),
})

const reservation: Attempt = {
  id: 'heldout.536',
  runId: 'heldout',
  arm: 'cheap-llm',
  fixtureId: 'case',
  repetition: 2,
  phase: 'reserve',
  reservedInput: 6703,
  reservedOutput: 1024,
  input: 6703,
  output: 1024,
  costUsd: 0.011823,
  status: 0,
  error: null,
  usageKnown: false,
  latencyMs: 0,
}
const model = models('fake')[0]
if (model === undefined) throw new Error('Missing model')
const manifest: Manifest = {
  schemaVersion: 1,
  runId: 'fresh',
  fixtureHash: 'fake',
  sourceHash: 'fake',
  repetitions: 3,
  batchSize: 2,
  prompt: 'test',
  questions: {},
  models: [model],
  limits: {
    maxRequests: 2000,
    maxUsd: 3,
    maxInput: 8000000,
    maxOutput: 2000000,
    perCallInput: 16000,
    perCallOutput: 1024,
  },
}
it('appends the approved full reservation once, retains unknown usage and never changes prior bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goblin-decisions-settle-'))
  const path = join(root, 'attempts.jsonl')
  const original = JSON.stringify(reservation) + '\n'
  const execute = (attemptId: string, ownerApproved: string | undefined) =>
    Effect.runPromise(
      settleUnfinished({ root, runId: 'heldout', attemptId, ownerApproved }).pipe(Effect.scoped, Effect.provide(files)),
    )
  try {
    await writeFile(path, original, { mode: 0o600 })
    await expect(execute(reservation.id, undefined)).rejects.toThrow('requires --owner-approved')
    await expect(execute('unknown', '2026-10-09')).rejects.toThrow('Unknown attempt')
    expect(await readFile(path, 'utf8')).toBe(original)
    const finished = await execute(reservation.id, '2026-10-09')
    expect(finished).toMatchObject({
      phase: 'settle',
      usageKnown: false,
      costUsd: 0.011823,
      input: 6703,
      output: 1024,
      ownerApproved: '2026-10-09',
    })
    const settledText = await readFile(path, 'utf8')
    expect(settledText).toBe(original + JSON.stringify(finished) + '\n')
    expect(totals([reservation, finished])).toMatchObject({ requests: 1, unfinished: false, usd: 0.011823 })
    expect(admission(manifest, [reservation, finished], model, 100, 100)).toBeNull()
    expect(admission(manifest, [reservation, { ...finished, ownerApproved: undefined }], model, 100, 100)).toBe(
      'unknown-usage',
    )
    await expect(execute(reservation.id, '2026-10-09')).rejects.toThrow('already settled')
    expect(await readFile(path, 'utf8')).toBe(settledText)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
