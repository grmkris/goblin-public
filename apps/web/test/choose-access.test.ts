import { describe, expect, it } from 'vitest'
import { startingScopes } from '../src/components/connection-forms.tsx'

describe('where Choose access starts (ADR 0042)', () => {
  const offered = ['notes', 'notes:write', 'admin', 'offline_access']

  it('starts from what the connection holds, else from everything offered, and never shows offline_access', () => {
    expect(startingScopes(offered, ['notes', 'offline_access'])).toEqual(['notes'])
    expect(startingScopes(offered, null)).toEqual(['notes', 'notes:write', 'admin'])
  })

  it('ignores held scopes the server no longer offers, and starts from all offered when none remain', () => {
    expect(startingScopes(offered, ['notes', 'legacy'])).toEqual(['notes'])
    expect(startingScopes(offered, ['legacy'])).toEqual(['notes', 'notes:write', 'admin'])
  })
})
