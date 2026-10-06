import * as Effect from 'effect/Effect'
import { expect } from 'vitest'

const probe = (url: string, path: string, name: string) =>
  Effect.promise(async () => {
    const response = await fetch(`${url.replace(/\/+$/u, '')}${path}?name=${name}`)
    const text = await response.text()
    expect(response.status, text).toBe(200)
    const result: unknown = JSON.parse(text)
    return result
  })

/** The owner's files on the real Shell Workspace and the stack's R2 bucket (ADR 0022). */
export function filesCase(url: string) {
  return Effect.gen(function* () {
    const store = yield* probe(url, '/files-store', `files-store-${Date.now()}`)
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
    const owner = `files-routes-${Date.now()}`
    const routes = yield* probe(url, '/files-sequence', owner)
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
  })
}
