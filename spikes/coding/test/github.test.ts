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
  const result = await new ExistingPr('grmkris/goblin', '/usr/bin/gh').publish(
    overlay,
    'title',
    'body',
    () => undefined,
  )
  expect(result).toEqual({ url: 'https://github.com/grmkris/goblin/pull/77', number: 77, commit: 'head-sha' })
})
