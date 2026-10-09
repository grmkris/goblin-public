import * as Schema from 'effect/Schema'
import { expect, test } from 'bun:test'
import { GitHub } from '../scripts/github.ts'
import { Overlay } from '../scripts/overlay.ts'

class ExistingPr extends GitHub {
  override async api(route: string): Promise<unknown> {
    if (route.startsWith('pulls?'))
      return [{ number: 77, html_url: 'https://github.com/grmkris/goblin/pull/77', head: { sha: 'head-sha' } }]
    throw new Error(`unexpected route ${route}`)
  }
}

test('publishing an existing deterministic branch returns its head commit', async () => {
  const path = 'apps/cli/src/main.ts'
  const overlay = new Overlay('base-sha', new Map([[path, 'base\n']]), 'session-id')
  const revision = overlay.edit(path, 'change\n', overlay.revision)
  overlay.check = { revision, passed: true, diagnostics: [], elapsedMs: 1 }
  overlay.publication = { title: 'title', body: 'body', commit: 'head-sha' }
  const result = await new ExistingPr('grmkris/goblin', '/usr/bin/gh').publish(
    overlay,
    'title',
    'body',
    () => undefined,
  )
  expect(result).toEqual({ url: 'https://github.com/grmkris/goblin/pull/77', number: 77, commit: 'head-sha' })
})

test('refuses a pre-existing PR without a matching retained publication commit', async () => {
  const path = 'apps/cli/src/main.ts'
  const overlay = new Overlay('base-sha', new Map([[path, 'base\n']]), 'session-id')
  const revision = overlay.edit(path, 'different edit\n', overlay.revision)
  overlay.check = { revision, passed: true, diagnostics: [], elapsedMs: 1 }
  let rejected = false
  try {
    await new ExistingPr('grmkris/goblin', '/usr/bin/gh').publish(overlay, 'title', 'body', () => undefined)
  } catch (error) {
    // expected: the test asserts on the failure it captures
    rejected = String(error).includes('publication_conflict')
  }
  expect(rejected).toBe(true)
})

class InterruptedPublish extends GitHub {
  reference: string | undefined
  commits = 0
  attempts = 0
  trees: unknown[] = []
  bodies: unknown[] = []
  override async api(route: string, body?: unknown): Promise<unknown> {
    if (route.startsWith('pulls?')) return []
    if (route === 'git/commits/base-sha') return { tree: { sha: 'base-tree' } }
    if (route === 'git/trees/base-tree?recursive=1') return { tree: [{ path: 'apps/cli/src/main.ts', mode: '100755' }] }
    if (route === 'git/trees') {
      this.trees.push(body)
      return { sha: 'checked-tree' }
    }
    if (route === 'git/commits') {
      this.commits++
      return { sha: 'checked-commit' }
    }
    if (route.startsWith('git/ref/heads/')) {
      if (!this.reference) throw new Error('missing ref')
      return { object: { sha: this.reference } }
    }
    if (route === 'git/refs') {
      this.reference = 'checked-commit'
      return {}
    }
    if (route === 'pulls') {
      this.bodies.push(body)
      if (++this.attempts === 1) throw new Error('interrupted after ref creation')
      return { number: 78, html_url: 'https://github.com/grmkris/goblin/pull/78', head: { sha: 'checked-commit' } }
    }
    throw new Error(`unexpected route ${route}`)
  }
}

test('reconciles an interrupted publication using the saved commit and existing ref', async () => {
  const path = 'apps/cli/src/main.ts'
  const overlay = new Overlay('base-sha', new Map([[path, 'base\n']]), 'session-id')
  const revision = overlay.edit(path, 'change\n', overlay.revision)
  overlay.check = {
    revision,
    passed: true,
    diagnostics: [],
    elapsedMs: 1,
    backend: 'docker',
    imageDigest: `sha256:${'a'.repeat(64)}`,
  }
  const github = new InterruptedPublish('grmkris/goblin', '/usr/bin/gh')
  let checkpoints = 0
  const persist = () => {
    checkpoints++
  }
  let interrupted = false
  try {
    await github.publish(overlay, 'title', 'body', persist)
  } catch (error) {
    // expected: the test asserts on the failure it captures
    interrupted = String(error).includes('interrupted')
  }
  expect(interrupted).toBe(true)
  expect(overlay.publication?.commit).toBe('checked-commit')
  expect(checkpoints).toBe(1)
  expect(() => overlay.edit(path, 'different\n', revision)).toThrow('session_frozen')
  const result = await github.publish(overlay, 'title', 'body', persist)
  expect(result.commit).toBe('checked-commit')
  const prBody = Schema.decodeUnknownSync(Schema.Struct({ body: Schema.String }))(github.bodies[1]).body
  expect(prBody).toContain(`Checked revision: \`${revision}\``)
  expect(prBody).toContain('Backend: docker')
  expect(prBody).toContain(`Image digest: sha256:${'a'.repeat(64)}`)
  expect(github.commits).toBe(1)
  expect(github.trees[0]).toEqual({
    base_tree: 'base-tree',
    tree: [{ path, mode: '100755', type: 'blob', content: 'change\n' }],
  })
})
