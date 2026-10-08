import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { State } from '../scripts/state.ts'
import { Overlay } from '../scripts/overlay.ts'

test('recovers the exact checked overlay and frozen publication intent after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goblin-coding-state-'))
  const state = new State(join(directory, 'sessions.json'))
  const files = new Map([['apps/cli/src/main.ts', 'baseline\n']])
  const overlay = new Overlay('base-sha', files, 'operation-id')
  const revision = overlay.edit('apps/cli/src/main.ts', 'edited\n', overlay.revision)
  overlay.check = { revision, passed: true, diagnostics: [], elapsedMs: 12 }
  overlay.publication = { title: 'title', body: 'body', commit: 'checked-commit' }
  state.save([overlay])
  const [restored] = state.load('base-sha', files)
  expect(restored?.revision).toBe(revision)
  expect(restored?.publication?.commit).toBe('checked-commit')
  expect(() => restored?.assertReady(revision)).not.toThrow()
  expect(() => restored?.edit('apps/cli/src/main.ts', 'other\n', revision)).toThrow('session_frozen')
  expect(() => state.load('another-base', files)).toThrow('state_base_mismatch')
})
