import * as Schema from 'effect/Schema'
import { expect } from 'vitest'
import { type NativeCase, freshName, probeOf } from './native-case.ts'

/** The owner's files on the real Shell Workspace and the stack's R2 bucket (ADR 0022). */
async function filesChecks(base: string): Promise<void> {
  const store = await probeOf(base, 'files-store', Schema.Unknown)
  expect(store).toEqual({
    written: '/agent/report.md',
    paged: true,
    agentUpload: 'Forbidden',
    agentDelete: 'Forbidden',
    declaredTooLarge: 'PayloadTooLarge',
    longer: 'PayloadTooLarge',
    longerStored: false,
    escape: 'InvalidInput',
    keys: [],
  })
  const owner = freshName('files-routes')
  const routes = await probeOf(base, 'files-sequence', Schema.Unknown, owner)
  expect(routes).toEqual({
    uploads: [201, 201, 201, 400],
    names: ['big.bin', 'dot.png', 'notes.txt'],
    usedBytes: 200 * 1024 + 11 + 4,
    spilled: [`agents/${owner}/files/uploads/big.bin`],
    big: {
      bytes: 200 * 1024,
      type: 'application/octet-stream',
      disposition: "attachment; filename*=UTF-8''big.bin",
      csp: "default-src 'none'; sandbox",
    },
    png: { type: 'image/png', disposition: "inline; filename*=UTF-8''dot.png" },
    deleted: 200,
    afterDelete: [],
    gone: 404,
    beforeErase: [`agents/${owner}/files/uploads/big-again.bin`],
    erased: { ok: true, value: true },
    afterErase: [],
  })
}

export const cases: readonly NativeCase[] = [
  {
    title: 'owner files keep small ones in SQLite, spill larger ones to R2 and erase them with the account [canary]',
    run: filesChecks,
  },
]
