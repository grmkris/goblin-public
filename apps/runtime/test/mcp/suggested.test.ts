import { describe, expect, it } from 'vitest'
import { suggestions } from '../../src/mcp/suggested.ts'

describe('the suggested servers', () => {
  it('uses each stage’s endpoint and marks what the owner already has', () => {
    const dev = suggestions('dev', new Set(['https://dev.mysi.lol/mcp?codemode=off']))
    expect(dev.find((item) => item.id === 'mysi')).toMatchObject({
      endpoint: 'https://dev.mysi.lol/mcp?codemode=off',
      group: 'yours',
      added: true,
      signIn: true,
    })
    expect(dev.find((item) => item.id === 'deepwiki')).toMatchObject({ added: false, signIn: false, group: 'code' })
    expect(suggestions('test', new Set()).find((item) => item.id === 'mysi')?.endpoint).toBe(
      'https://mysi.lol/mcp?codemode=off',
    )
  })
  it('counts a mysi connection made without the query as added', () => {
    const shelf = suggestions('prod', new Set(['https://mysi.lol/mcp/']))
    expect(shelf.find((item) => item.id === 'mysi')?.added).toBe(true)
  })
  it('offers mysi once instead of each my* app', () => {
    const ids = suggestions('prod', new Set()).map((item) => item.id)
    expect(ids).toContain('mysi')
    for (const app of ['myplan', 'mytab', 'mygram', 'myinbox', 'myskills']) expect(ids).not.toContain(app)
  })
  it('shelves Goblin Wallet, signed in over OAuth, and marks it added once the owner has it', () => {
    const endpoint = 'https://wallet-dev.goblin.surf/mcp'
    expect(suggestions('dev', new Set()).find((item) => item.id === 'wallet')).toMatchObject({
      title: 'Goblin Wallet',
      endpoint,
      group: 'goblin',
      signIn: true,
      added: false,
    })
    expect(suggestions('dev', new Set([endpoint])).find((item) => item.id === 'wallet')?.added).toBe(true)
    // Prod never sends an owner to the dev wallet.
    expect(suggestions('prod', new Set()).find((item) => item.id === 'wallet')?.endpoint).toBe(
      'https://wallet.goblin.surf/mcp',
    )
  })
  it('suggests only https endpoints, each id once, and nothing Mercator already sells', () => {
    const all = suggestions(undefined, new Set())
    expect(new Set(all.map((item) => item.id)).size).toBe(all.length)
    for (const item of all) expect(new URL(item.endpoint).protocol).toBe('https:')
    for (const host of ['mcp.exa.ai', 'mcp.firecrawl.dev'])
      expect(all.some((item) => new URL(item.endpoint).host === host)).toBe(false)
  })
  it('needs sign-in only for the owner’s own apps and goblin’s services', () => {
    for (const item of suggestions('prod', new Set()))
      expect(item.signIn).toBe(item.group === 'yours' || item.group === 'goblin')
  })
})

it('maps mysi to its stage endpoint', () => {
  for (const stage of ['local', 'dev', 'prod', 'test'] as const) {
    const dev = stage === 'local' || stage === 'dev'
    expect(suggestions(stage, new Set()).find((item) => item.id === 'mysi')?.endpoint).toBe(
      `https://${dev ? 'dev.' : ''}mysi.lol/mcp?codemode=off`,
    )
  }
})
