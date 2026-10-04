import { describe, expect, it } from 'vitest'
import { suggestions } from '../../src/mcp/suggested.ts'

describe('the suggested servers', () => {
  it('uses each stage’s endpoint and marks what the owner already has', () => {
    const dev = suggestions('dev', new Set(['https://dev-new.myplan.lol/mcp']))
    expect(dev.find((item) => item.id === 'myplan')).toMatchObject({
      endpoint: 'https://dev-new.myplan.lol/mcp',
      added: true,
      signIn: true,
    })
    expect(dev.find((item) => item.id === 'deepwiki')).toMatchObject({ added: false, signIn: false })
    expect(suggestions('test', new Set()).find((item) => item.id === 'myplan')?.endpoint).toBe('https://myplan.lol/mcp')
  })
  it('suggests only https endpoints, each id once', () => {
    const all = suggestions(undefined, new Set())
    expect(new Set(all.map((item) => item.id)).size).toBe(all.length)
    for (const item of all) expect(new URL(item.endpoint).protocol).toBe('https:')
  })
})
