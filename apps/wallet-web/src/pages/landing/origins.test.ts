import { describe, expect, it } from 'vitest'
import { claudeCodeCommand, goblinSite, mcpEndpoint } from './origins.ts'

describe('goblinSite', () => {
  it('pairs each wallet stage with its goblin', () => {
    expect(goblinSite('https://wallet.goblin.surf')).toBe('https://goblin.surf')
    expect(goblinSite('https://wallet-dev.goblin.surf')).toBe('https://dev.goblin.surf')
  })

  it('sends a local preview or an unknown host to the public site', () => {
    expect(goblinSite('http://localhost:18980')).toBe('https://goblin.surf')
    expect(goblinSite('http://wallet.goblin.surf')).toBe('https://goblin.surf')
    expect(goblinSite('https://pay.example.com')).toBe('https://goblin.surf')
    expect(goblinSite('not an origin')).toBe('https://goblin.surf')
  })
})

describe('the MCP endpoint', () => {
  it("is the page's own origin, and Claude Code adds it over HTTP", () => {
    const endpoint = mcpEndpoint('https://wallet-dev.goblin.surf')
    expect(endpoint).toBe('https://wallet-dev.goblin.surf/mcp')
    expect(claudeCodeCommand(endpoint)).toBe(
      'claude mcp add --transport http goblin-wallet https://wallet-dev.goblin.surf/mcp',
    )
  })
})
