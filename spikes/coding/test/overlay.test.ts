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
})
