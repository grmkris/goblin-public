import { describe, expect, it } from 'vitest'
import { suggestions } from '../../src/mcp/suggested.ts'

describe('the suggested servers', () => {
  it('uses each stage’s endpoint and marks what the owner already has', () => {
    const dev = suggestions('dev', new Set(['https://dev.myplan.lol/mcp']))
    expect(dev.find((item) => item.id === 'myplan')).toMatchObject({
      endpoint: 'https://dev.myplan.lol/mcp',
      added: true,
      signIn: true,
    })
    expect(dev.find((item) => item.id === 'deepwiki')).toMatchObject({ added: false, signIn: false })
    expect(suggestions('test', new Set()).find((item) => item.id === 'myplan')?.endpoint).toBe('https://myplan.lol/mcp')
  })
  it('shelves Goblin Wallet, signed in over OAuth, and marks it added once the owner has it', () => {
    const endpoint = 'https://wallet-dev.goblin.surf/mcp'
    expect(suggestions('dev', new Set()).find((item) => item.id === 'wallet')).toMatchObject({
      title: 'Goblin Wallet',
      endpoint,
      signIn: true,
      added: false,
    })
    expect(suggestions('dev', new Set([endpoint])).find((item) => item.id === 'wallet')?.added).toBe(true)
  })
  it('suggests only https endpoints, each id once', () => {
    const all = suggestions(undefined, new Set())
    expect(new Set(all.map((item) => item.id)).size).toBe(all.length)
    for (const item of all) expect(new URL(item.endpoint).protocol).toBe('https:')
  })
})

it('maps suggested services to their stage endpoints', () => {
  for (const stage of ['local', 'dev', 'prod', 'test'] as const) {
    const shelf = suggestions(stage, new Set())
    const dev = stage === 'local' || stage === 'dev'
    expect(shelf.find((item) => item.id === 'mygram')?.endpoint).toBe(`https://${dev ? 'dev.' : ''}mygram.lol/mcp`)
    expect(shelf.find((item) => item.id === 'myskills')?.endpoint).toBe(`https://${dev ? 'dev.' : ''}myskills.lol/mcp`)
    expect(shelf.find((item) => item.id === 'myplan')?.endpoint).toBe(`https://${dev ? 'dev.' : ''}myplan.lol/mcp`)
    expect(shelf.find((item) => item.id === 'myinbox')?.endpoint).toBe(
      `https://${stage === 'local' ? 'dev.' : ''}myinbox.lol/mcp`,
    )
  }
})
