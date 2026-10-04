import { describe, expect, it } from 'vitest'
import { clientFromClaims } from '../../src/auth/principal.ts'

describe('inbound client claims (unit)', () => {
  const expected = { issuer: 'https://dev.example/api/auth', resource: 'https://dev.example/mcp', now: 100 }
  const valid = { iss: expected.issuer, sub: 'owner', azp: 'cli', aud: expected.resource, exp: 101, scope: 'openid' }
  it('accepts our issuer, audience and an unexpired token', () => {
    expect(clientFromClaims(valid, expected)).toEqual({
      clientId: 'cli',
      subject: 'owner',
      scopes: ['openid'],
      expiresAt: 101,
    })
  })
  it('rejects foreign issuers, other audiences, expiry and sender-constrained tokens', () => {
    const reason = (claims: object) => {
      try {
        clientFromClaims(claims, expected)
        return 'accepted'
      } catch (error) {
        return error instanceof Error && 'reason' in error ? error.reason : 'unknown'
      }
    }
    expect(reason({ ...valid, iss: 'https://evil' })).toBe('issuer')
    expect(reason({ ...valid, aud: 'https://dev.example/other' })).toBe('audience')
    expect(reason({ ...valid, exp: 100 })).toBe('expired')
    expect(reason({ ...valid, azp: undefined })).toBe('client')
    expect(reason({ ...valid, cnf: { jkt: 'x' } })).toBe('sender-constrained tokens are not supported')
  })
})
