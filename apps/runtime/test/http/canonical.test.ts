import { expect, test } from 'vitest'
import { canonicalRedirect } from '../../src/http/canonical.ts'
import { resolveStage } from '../../../../scripts/stage-config.ts'

test('alternate hosts redirect without trusting forwarded hosts or losing path and query', () => {
  for (const method of ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE']) {
    const response = canonicalRedirect(
      new Request('https://old.workers.dev//path?q=a%2Fb', {
        method,
        headers: { 'x-forwarded-host': 'attacker.example' },
      }),
      'https://purrable.lol',
    )
    expect(response?.status).toBe(method === 'GET' || method === 'HEAD' ? 301 : 308)
    expect(response?.headers.get('location')).toBe('https://purrable.lol//path?q=a%2Fb')
  }
  expect(canonicalRedirect(new Request('https://purrable.lol/health'), 'https://purrable.lol')).toBeUndefined()
})

test('prod resources are isolated and unsupported stages are refused', () => {
  const stage = resolveStage('prod')
  expect(stage.workerName).toBe('purrable-prod')
  expect(stage.resourceName('auth')).toBe('purrable-prod-auth')
  expect(stage.local).toBe(false)
  expect(() => resolveStage('production')).toThrow('unsupported_stage')
})
