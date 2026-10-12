import { describe, expect, it } from 'vitest'
import { CONNECTIONS } from '../api/fixtures.ts'
import { accessOf, lastUsedOf } from './agents-model.ts'

describe('accessOf', () => {
  it('says spending first, then looking, and names a scope it does not know', () => {
    expect(accessOf(['wallet:read', 'wallet:spend'])).toBe('Can spend within your limits')
    expect(accessOf(['wallet:read'])).toBe('Can see balances and activity')
    expect(accessOf([])).toBe('No wallet access')
    expect(accessOf(['wallet:read', 'wallet:admin'])).toBe('Can see balances and activity; also wallet:admin')
  })
})

describe('lastUsedOf', () => {
  it('says when the agent last used the wallet, or that it has not', () => {
    const [goblin] = CONNECTIONS
    if (goblin === undefined) throw new Error('fixture connection missing')
    const now = Date.parse(goblin.lastUsedAt ?? '') + 5 * 60_000
    expect(lastUsedOf(goblin, now)).toBe('Used 5 min ago')
    const { lastUsedAt: _, ...unused } = goblin
    expect(lastUsedOf(unused, now)).toBe('Not used yet')
  })
})
