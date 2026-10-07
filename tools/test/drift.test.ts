import { describe, expect, it } from 'vitest'
import { canonical, observed } from '../../scripts/drift-attributes.ts'

const same = (name: string, a: Record<string, unknown>, b: Record<string, unknown>) =>
  canonical(observed(name, a)) === canonical(observed(name, b))

describe('provider attribute drift', () => {
  it('normalizes only unobservable zone bookkeeping and default disabled replication', () => {
    expect(same('Web', { domain: { name: 'goblin.surf', zone: 'z' } }, { domain: { name: 'goblin.surf' } })).toBe(true)
    expect(same('goblinAuth', {}, { readReplication: { mode: 'disabled' } })).toBe(true)
    expect(same('Web', { missing: undefined, tags: ['a', 'b'] }, { tags: ['a', 'b'] })).toBe(true)
  })
  it('rejects changed domains, replication, namespace, routes and tags', () => {
    expect(same('Web', { domain: { name: 'goblin.surf' } }, { domain: { name: 'other.surf' } })).toBe(false)
    expect(same('goblinAuth', {}, { readReplication: { mode: 'auto' } })).toBe(false)
    expect(same('Web', { durableObjectNamespaces: { a: 'one' } }, { durableObjectNamespaces: { a: 'two' } })).toBe(
      false,
    )
    expect(same('Web', { routes: [] }, { routes: [{ pattern: '*example.com' }] })).toBe(false)
    expect(same('Web', { tags: ['a', 'b'] }, { tags: ['b', 'a'] })).toBe(false)
  })
})
