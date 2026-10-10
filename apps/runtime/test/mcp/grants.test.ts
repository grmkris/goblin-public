import { createMcpHandler } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import { MemoryCredentials, MemoryGrants } from './memory.ts'
import { lowLevelServer } from './low-level-server.ts'
import { BOARD, boardTools } from './notes-board.ts'
import { hostOf } from './manager.ts'

/** A notes server whose board App uses `open` (offered to the model) and `move` (App-only); `delete` is separate. */
const notes = createMcpHandler(() => {
  const server = lowLevelServer({ name: 'notes', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler('tools/list', boardTools)
  return server
})

async function host() {
  const credentials = new MemoryCredentials()
  await credentials.saveTokens('notes', { access_token: 'fixture-token', token_type: 'bearer' }, 0)
  return hostOf({
    servers: [{ serverId: 'notes', endpoint: 'https://notes.test/mcp' }],
    credentials,
    grants: new MemoryGrants(),
    fetch: async (input, init) => notes.fetch(new Request(input, init)),
  })
}

const allowed = async (mcp: Awaited<ReturnType<typeof host>>) =>
  (await mcp.grants.list()).map((grant) => `${grant.capability}:${grant.name}`).toSorted()

describe('allowing an App as a whole', () => {
  it('grants exactly the tools that declare the App, and its resource; nothing else', async () => {
    const mcp = await host()
    try {
      await mcp.grants.setApp('notes', BOARD, true)
      expect(await allowed(mcp)).toEqual([`resource:${BOARD}`, 'tool:move', 'tool:open'])
      await mcp.grants.setApp('notes', BOARD, false)
      expect(await allowed(mcp)).toEqual([])
    } finally {
      await mcp.dispose()
    }
  })
  it('refuses an App no tool declares', async () => {
    const mcp = await host()
    try {
      await expect(mcp.grants.setApp('notes', 'ui://notes/other.html', true)).rejects.toMatchObject({
        _tag: 'NotFound',
      })
      expect(await allowed(mcp)).toEqual([])
    } finally {
      await mcp.dispose()
    }
  })
})
