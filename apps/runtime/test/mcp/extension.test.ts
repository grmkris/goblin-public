import { describe, expect, it } from 'vitest'
import { mcpModelResult } from '../../src/mcp/extension.ts'

describe('Pi MCP result projection (unit)', () => {
  it('keeps public asset token fields while scrubbing nested credential-shaped keys', () => {
    const projected = mcpModelResult('sidequest', {
      content: [],
      structuredContent: {
        rewardToken: '0x123',
        token: '0x456',
        tokens: 3,
        tokenId: '42',
        tokenAddress: '0x789',
        assetAddress: '0xabc',
        jobs: [
          {
            accessToken: 'private-access',
            refresh_token: 'private-refresh',
            idToken: 'private-id',
            bearer_token: 'private-bearer',
            apiToken: 'private-api',
            session_token: 'private-session',
            secret: 'private-secret',
            clientSecret: 'private-client',
            password: 'private-password',
            authorization: 'private-auth',
            cookie: 'private-cookie',
            private_key: 'private-key',
            apiKey: 'private-key',
          },
        ],
      },
    })
    expect(projected.details).toMatchObject({
      structuredContent: {
        rewardToken: '0x123',
        token: '0x456',
        tokens: 3,
        tokenId: '42',
        tokenAddress: '0x789',
        assetAddress: '0xabc',
        jobs: [
          {
            accessToken: '[redacted]',
            refresh_token: '[redacted]',
            idToken: '[redacted]',
            bearer_token: '[redacted]',
            apiToken: '[redacted]',
            session_token: '[redacted]',
            secret: '[redacted]',
            clientSecret: '[redacted]',
            password: '[redacted]',
            authorization: '[redacted]',
            cookie: '[redacted]',
            private_key: '[redacted]',
            apiKey: '[redacted]',
          },
        ],
      },
    })
    expect(JSON.stringify(projected.details)).not.toContain('private-')
  })
  it('retains supported blocks, tags rich data, and redacts secret fields in model details', () => {
    const projected = mcpModelResult('fixture', {
      content: [
        { type: 'text', text: 'Remote content' },
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
        { type: 'resource_link', uri: 'ui://fixture/view.html', name: 'View' },
      ],
      structuredContent: { safe: true, apiKey: 'private-value' },
      _meta: { nested: { authorization: 'Bearer private-value' } },
      isError: true,
    })
    expect(projected.content?.[0]).toMatchObject({ type: 'text', text: expect.stringContaining('untrusted') })
    expect(projected.content?.[1]).toEqual({ type: 'text', text: 'Remote content' })
    expect(projected.content?.[2]).toEqual({ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' })
    expect(projected.content?.[3]).toMatchObject({ type: 'text', text: expect.stringContaining('resource_link') })
    expect(projected.isError).toBe(true)
    expect(JSON.stringify(projected.details)).not.toContain('private-value')
    expect(projected.details).toMatchObject({ structuredContent: { safe: true, apiKey: '[redacted]' } })
  })
})
