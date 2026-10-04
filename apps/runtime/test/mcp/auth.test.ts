import { describe, expect, it } from 'vitest'
import { principalFromClaims, requireDevBootstrap, requireGrant, type GrantStore } from '../../src/auth/principal.ts'

describe('mcp principal boundary (unit)', () => {
  const expected = { issuer: 'https://dev.example/api/auth', resource: 'https://dev.example/mcp', now: 100 }
  it('requires issuer, audience, expiry and client identity', () => {
    expect(
      principalFromClaims(
        {
          iss: expected.issuer,
          sub: 'owner',
          azp: 'cli',
          aud: expected.resource,
          exp: 101,
          scope: 'read write',
          grant_gen: 2,
        },
        expected,
      ),
    ).toMatchObject({ subject: 'owner', clientId: 'cli', scopes: ['read', 'write'], grantGeneration: 2 })
    expect(() =>
      principalFromClaims(
        { iss: 'https://evil', sub: 'owner', azp: 'cli', aud: expected.resource, exp: 101 },
        expected,
      ),
    ).toThrow('mcp_issuer_mismatch')
    expect(() =>
      principalFromClaims({ iss: expected.issuer, sub: 'owner', azp: 'cli', aud: 'other', exp: 101 }, expected),
    ).toThrow('mcp_audience_mismatch')
    expect(() =>
      principalFromClaims(
        { iss: expected.issuer, sub: 'owner', azp: 'cli', aud: expected.resource, exp: 100 },
        expected,
      ),
    ).toThrow('mcp_token_expired')
  })
  it('requires current exact grants and scope', async () => {
    const store: GrantStore = {
      currentGeneration: async () => 3,
      findGrant: async () => ({
        issuer: expected.issuer,
        subject: 'owner',
        clientId: 'cli',
        serverId: 'myplan',
        capability: 'tool',
        name: 'document_read',
        scopes: ['read'],
        generation: 3,
      }),
    }
    const principal = principalFromClaims(
      {
        iss: expected.issuer,
        sub: 'owner',
        azp: 'cli',
        aud: expected.resource,
        exp: 4102444800,
        scope: 'read',
        grant_gen: 3,
      },
      expected,
    )
    await expect(
      requireGrant(store, principal, { serverId: 'myplan', capability: 'tool', name: 'document_read' }),
    ).resolves.toMatchObject({ generation: 3 })
    await expect(
      requireGrant(
        store,
        { ...principal, grantGeneration: 2 },
        { serverId: 'myplan', capability: 'tool', name: 'document_read' },
      ),
    ).rejects.toThrow('mcp_grant_denied')
  })
  it('only accepts configured owner bootstrap in explicit dev stages', () => {
    expect(() =>
      requireDevBootstrap(
        { STAGE: 'dev', OWNER_EMAIL: 'owner@example.test', OWNER_BOOTSTRAP_TOKEN: 'secret' },
        'secret',
      ),
    ).not.toThrow()
    expect(() =>
      requireDevBootstrap(
        { STAGE: 'production', OWNER_EMAIL: 'owner@example.test', OWNER_BOOTSTRAP_TOKEN: 'secret' },
        'secret',
      ),
    ).toThrow('owner_bootstrap_disabled')
    expect(() =>
      requireDevBootstrap({ STAGE: 'dev', OWNER_EMAIL: 'owner@example.test', OWNER_BOOTSTRAP_TOKEN: 'secret' }, 'bad'),
    ).toThrow('owner_bootstrap_denied')
  })
})
