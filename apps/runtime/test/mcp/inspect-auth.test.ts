import { describe, expect, it } from 'vitest'
import { grantedScopes } from '../../src/auth/principal.ts'
import { MCP_SCOPES, challengeOf, mcpResource, protectedResourceMetadata } from '../../src/auth/resources.ts'

const APP = 'https://goblin.test'
const ISSUER = `${APP}/api/auth`

describe('the /mcp resource (unit, ADR 0024)', () => {
  it('is one resource whose metadata offers inspection as a scope', () => {
    expect(mcpResource(`${APP}/`)).toBe(`${APP}/mcp`)
    expect(protectedResourceMetadata(APP, ISSUER)).toEqual({
      resource: `${APP}/mcp`,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
      scopes_supported: ['openid', 'profile', 'email', 'offline_access', 'goblin:inspect'],
      resource_name: 'goblin',
    })
  })

  it('challenges with the metadata and every scope, so a new connection asks for inspection', () => {
    const challenge = challengeOf(`${APP}/`)
    expect(challenge.status).toBe(401)
    expect(challenge.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${APP}/.well-known/oauth-protected-resource/mcp", scope="${MCP_SCOPES.join(' ')}"`,
    )
  })

  it('reads the scopes a standing consent grants, and none from a malformed one', () => {
    expect(grantedScopes({ scopes: '["openid","goblin:inspect"]' })).toEqual(['openid', 'goblin:inspect'])
    expect(grantedScopes({ scopes: null })).toEqual([])
    expect(grantedScopes({ scopes: 'goblin:inspect' })).toEqual([])
    expect(grantedScopes({ scopes: '{"goblin:inspect":true}' })).toEqual([])
    expect(grantedScopes({ scopes: '["openid",3]' })).toEqual(['openid'])
  })
})
