import { expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { Overlay } from '../scripts/overlay.ts'
import { Verifier } from '../scripts/verifier.ts'
import { compilers } from '../scripts/binaries.ts'

const root = path.resolve(import.meta.dirname, '../../../.local/coding-spike/repo')
const main = 'apps/cli/src/main.ts'

test('native verifier rejects virtual errors then accepts a correction without changing the snapshot', async () => {
  const original = await readFile(path.join(root, main), 'utf8')
  const state = await mkdtemp(path.join(tmpdir(), 'goblin-coding-verifier-'))
  const binaries = compilers(state)
  const overlay = new Overlay('base', new Map([[main, original]]))
  const verifier = new Verifier(root, overlay, binaries.effect, binaries.type)
  try {
    const file = 'apps/cli/src/coding-probe.ts'
    overlay.edit(file, 'export const codingProbe: number = "wrong"\nPromise.resolve(1)\n', overlay.revision)
    const rejected = await verifier.ready()
    expect(rejected.passed).toBe(false)
    expect(JSON.stringify(rejected.diagnostics)).toContain('2322')
    expect(JSON.stringify(rejected.diagnostics)).toContain('no-floating-promises')
    expect(JSON.stringify(rejected.diagnostics)).toContain('oxfmt')
    overlay.edit(file, "import { Effect } from 'effect'\nEffect.succeed(1)\n", overlay.revision)
    const effectRejected = await verifier.ready()
    expect(effectRejected.passed).toBe(false)
    expect(JSON.stringify(effectRejected.diagnostics)).toContain('floatingEffect')
    overlay.edit(file, 'export const codingProbe = 1\n', overlay.revision)
    const accepted = await verifier.ready()
    expect(accepted.diagnostics).toEqual([])
    expect(accepted.passed).toBe(true)
    expect(await readFile(path.join(root, main), 'utf8')).toBe(original)
    expect(await Bun.file(path.join(root, file)).exists()).toBe(false)
  } finally {
    await verifier.close()
  }
}, 60_000)
