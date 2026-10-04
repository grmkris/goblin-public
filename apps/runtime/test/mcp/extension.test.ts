import { describe, expect, it } from 'vitest'
import { mcpModelResult } from '../../src/mcp/extension.ts'

describe('Pi MCP result projection (unit)', () => {
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
