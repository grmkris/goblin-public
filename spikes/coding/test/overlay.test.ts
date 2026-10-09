import { describe, expect, test } from 'bun:test'
import { Overlay, SpikeError } from '../scripts/overlay.ts'

const file = 'apps/cli/src/main.ts'
const base = new Map([[file, 'export const answer = 1\n']])

describe('coding overlay', () => {
  test('rejects paths outside the CLI TypeScript allowlist', () => {
    const overlay = new Overlay('base', base)
    expect(() => overlay.read('../package.json')).toThrowError(new SpikeError('invalid_repo_path'))
    expect(() => overlay.edit('apps/runtime/src/main.ts', 'x', overlay.revision)).toThrowError(
      new SpikeError('path_outside_cli_spike'),
    )
  })

  test('accepts test filenames and nested TypeScript paths while rejecting traversal', () => {
    const overlay = new Overlay('base', base)
    overlay.edit('apps/cli/test/hello.test.ts', 'export const test = 1\n', overlay.revision)
    overlay.edit('apps/cli/src/commands/hello.ts', 'export const hello = 1\n', overlay.revision)
    expect(overlay.changes.size).toBe(2)
    expect(() => overlay.edit('apps/cli/test/../outside.ts', 'x', overlay.revision)).toThrow('invalid_repo_path')
  })

  test('invalidates readiness when the revision changes', () => {
    const overlay = new Overlay('base', base)
    const revision = overlay.edit(file, 'export const answer = 2\n', overlay.revision)
    expect(() => overlay.assertReady(revision)).toThrowError(new SpikeError('ready_required'))
    overlay.check = { revision, passed: true, diagnostics: [], elapsedMs: 1 }
    expect(() => overlay.assertReady(revision)).not.toThrow()
    const next = overlay.edit(file, 'export const answer = 3\n', revision)
    expect(next).not.toBe(revision)
    expect(() => overlay.assertReady(next)).toThrowError(new SpikeError('ready_required'))
  })

  test('restoring the baseline content removes an overlay change', () => {
    const overlay = new Overlay('base', base)
    const revision = overlay.edit(file, 'export const answer = 2\n', overlay.revision)
    overlay.edit(file, base.get(file)!, revision)
    expect(overlay.changes.size).toBe(0)
    expect(() => overlay.assertReady(overlay.revision)).toThrowError(new SpikeError('no_changes'))
  })

  test('refuses stale revisions and concurrent edits during verification', async () => {
    const overlay = new Overlay('base', base)
    const original = overlay.revision
    overlay.edit(file, 'export const answer = 2\n', original)
    expect(() => overlay.edit(file, 'export const answer = 3\n', original)).toThrow('stale_revision')
    await overlay.exclusive(async () => {
      expect(() => overlay.edit(file, 'export const answer = 3\n', overlay.revision)).toThrow('session_frozen')
      let busy = false
      try {
        await overlay.exclusive(async () => undefined)
      } catch (error) {
        // expected: the test asserts on the failure it captures
        busy = String(error).includes('session_busy')
      }
      expect(busy).toBe(true)
    })
    expect(overlay.busy).toBe(false)
  })
})
