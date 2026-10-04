import { describe, expect, it } from 'vitest'
import { filledEndpoint } from '../src/components/server-search.tsx'

describe('filling a registry endpoint template', () => {
  it('fills each placeholder with one safe path segment', () => {
    expect(filledEndpoint('https://myplan.lol/mcp/{workspaceId}', { workspaceId: ' ws_ab12 ' })).toBe(
      'https://myplan.lol/mcp/ws_ab12',
    )
    expect(filledEndpoint('https://myplan.lol/mcp', {})).toBe('https://myplan.lol/mcp')
  })
  it('refuses missing values and anything that could change the host or path', () => {
    expect(filledEndpoint('https://myplan.lol/mcp/{workspaceId}', {})).toBeUndefined()
    for (const value of ['../admin', 'a/b', 'evil.test@x', 'a?b=1', 'a#b'])
      expect(filledEndpoint('https://myplan.lol/mcp/{id}', { id: value })).toBeUndefined()
  })
})
