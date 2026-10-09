import { describe, expect, it } from 'vitest'
import { markLoopbackClientsNative } from '../../src/auth/options.ts'
import { signupAllowed, signupMode } from '../../src/auth/signup.ts'
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
        // expected: the test asserts on the reason the claims were refused
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

describe('dynamic registration of loopback MCP clients (unit)', () => {
  it('marks http-loopback-only registrations native and leaves the rest alone', () => {
    const loopback = { redirect_uris: ['http://localhost:33418/callback', 'http://127.0.0.1:9/cb'] }
    markLoopbackClientsNative(loopback)
    expect(loopback).toMatchObject({ application_type: 'native' })
    const web = { redirect_uris: ['https://app.example/cb'] }
    markLoopbackClientsNative(web)
    expect(web).not.toHaveProperty('application_type')
    const mixed = { redirect_uris: ['http://localhost/cb', 'http://evil.example/cb'] }
    markLoopbackClientsNative(mixed)
    expect(mixed).not.toHaveProperty('application_type')
    const declared = { redirect_uris: ['http://localhost/cb'], application_type: 'web' }
    markLoopbackClientsNative(declared)
    expect(declared.application_type).toBe('web')
  })
})

describe('sign-up modes (unit)', () => {
  it('admits everyone when open, only the matching code on invite, and no one when closed or unset', () => {
    expect(signupAllowed('open', '', '')).toBe(true)
    expect(signupAllowed('invite', 'let-me-in-2026', 'let-me-in-2026')).toBe(true)
    expect(signupAllowed('invite', 'let-me-in-2026', 'let-me-in-2025')).toBe(false)
    expect(signupAllowed('invite', 'let-me-in-2026', '')).toBe(false)
    // An invite mode without a configured code must not turn into "any empty header passes".
    expect(signupAllowed('invite', '', '')).toBe(false)
    expect(signupAllowed('closed', 'let-me-in-2026', 'let-me-in-2026')).toBe(false)
    expect([signupMode('open'), signupMode('invite'), signupMode(undefined), signupMode('OPEN')]).toEqual([
      'open',
      'invite',
      'closed',
      'closed',
    ])
  })
})
