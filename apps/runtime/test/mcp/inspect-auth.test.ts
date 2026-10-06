import { describe, expect, it } from 'vitest'
import { consentCovers } from '../../src/auth/principal.ts'
import { challengeOf, endpointOfMetadata, protectedResourceMetadata, resourceOf } from '../../src/auth/resources.ts'

const APP = 'https://goblin.test'
const ISSUER = `${APP}/api/auth`

describe('inspection resources (unit, ADR 0024)', () => {
  it('gives each endpoint its own audience, metadata and scope', () => {
    expect(resourceOf(`${APP}/`, 'inspect')).toBe(`${APP}/mcp/inspect`)
    expect(protectedResourceMetadata(APP, ISSUER, 'inspect')).toEqual({
      resource: `${APP}/mcp/inspect`,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
      scopes_supported: ['goblin:inspect', 'offline_access'],
      resource_name: 'goblin inspection',
    })
    expect(protectedResourceMetadata(APP, ISSUER, 'ask').scopes_supported).toEqual([
      'openid',
      'profile',
      'email',
      'offline_access',
    ])
  })

  it('reads the endpoint from the metadata path, defaulting to /mcp', () => {
    expect(endpointOfMetadata('/.well-known/oauth-protected-resource/mcp/inspect')).toBe('inspect')
    expect(endpointOfMetadata('/.well-known/oauth-protected-resource/mcp/inspect/')).toBe('inspect')
    expect(endpointOfMetadata('/.well-known/oauth-protected-resource/mcp/operator')).toBe('ask')
    expect(endpointOfMetadata('/.well-known/oauth-protected-resource/mcp')).toBe('ask')
    expect(endpointOfMetadata('/.well-known/oauth-protected-resource')).toBe('ask')
    expect(endpointOfMetadata('/.well-known/oauth-protected-resource/mcp/elsewhere')).toBe('ask')
  })

  it('challenges with the endpoint metadata, and the scope to ask for on inspection endpoints', () => {
    expect(challengeOf(APP, 'ask').headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${APP}/.well-known/oauth-protected-resource/mcp"`,
    )
    const inspect = challengeOf(APP, 'inspect')
    expect(inspect.status).toBe(401)
    expect(inspect.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${APP}/.well-known/oauth-protected-resource/mcp/inspect", scope="goblin:inspect offline_access"`,
    )
  })

  it('needs the scope and the resource in the standing consent, and nothing for /mcp', () => {
    const resource = `${APP}/mcp/inspect`
    const granted = { scopes: '["goblin:inspect","offline_access"]', resources: `["${resource}"]` }
    expect(consentCovers(granted, 'goblin:inspect', resource)).toBe(true)
    expect(consentCovers({ ...granted, resources: `["${APP}/mcp"]` }, 'goblin:inspect', resource)).toBe(false)
    expect(consentCovers({ ...granted, resources: null }, 'goblin:inspect', resource)).toBe(false)
    expect(consentCovers({ scopes: 'goblin:inspect', resources: 'garbage' }, 'goblin:inspect', resource)).toBe(false)
    expect(consentCovers({ scopes: null, resources: null }, undefined, `${APP}/mcp`)).toBe(true)
  })
})
