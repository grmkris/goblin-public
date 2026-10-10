import { describe, expect, it } from 'vitest'
import { filledEndpoint, searchOf } from '../src/components/server-search.tsx'

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

/** A settled catalog read that answered `data`. */
const read = (data?: { entries: []; partial: boolean }) => ({ isFetching: false, error: null, data })

describe('what a registry search shows', () => {
  it('waits for two characters, and while the text settles or the read runs', () => {
    expect(searchOf('a', 'a', read())).toEqual({ kind: 'idle' })
    expect(searchOf('notes', 'note', read({ entries: [], partial: false }))).toEqual({ kind: 'searching' })
    expect(searchOf('notes', 'notes', { ...read(), isFetching: true })).toEqual({ kind: 'searching' })
  })

  it('says when a registry did not answer, so some servers may be missing', () => {
    expect(searchOf('notes', 'notes', read({ entries: [], partial: true }))).toEqual({
      kind: 'found',
      results: [],
      partial: true,
    })
    expect(searchOf('notes', 'notes', read({ entries: [], partial: false }))).toMatchObject({ partial: false })
  })
})
