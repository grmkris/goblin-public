import { createMcpHandler, Server } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import { McpHost } from '../../src/mcp/host.ts'
import { MemoryCredentials, MemoryGrants } from './memory.ts'

const BOARD = 'ui://notes/board.html'

/** A notes server whose board App uses `open` (offered to the model) and `move` (App-only); `delete` is separate. */
const notes = createMcpHandler(() => {
  // oxlint-disable-next-line typescript/no-deprecated -- the low-level SDK Server keeps this fixture's tool list exact.
  const server = new Server({ name: 'notes', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler('tools/list', () => ({
    tools: [
      { name: 'open', inputSchema: { type: 'object', properties: {} }, _meta: { ui: { resourceUri: BOARD } } },
      {
        name: 'move',
        inputSchema: { type: 'object', properties: {} },
        _meta: { ui: { resourceUri: BOARD, visibility: ['app'] } },
      },
      { name: 'delete', inputSchema: { type: 'object', properties: {} } },
    ],
  }))
  return server
})

async function host() {
  const credentials = new MemoryCredentials()
  await credentials.saveTokens('notes', { access_token: 'fixture-token', token_type: 'bearer' }, 0)
  return new McpHost({
    servers: [{ serverId: 'notes', endpoint: 'https://notes.test/mcp' }],
    credentials,
    grants: new MemoryGrants(),
    appUrl: 'https://purrable.test',
    fetch: async (input, init) => notes.fetch(new Request(input, init)),
  })
}

const allowed = (mcp: McpHost) =>
  mcp
    .grants()
    .map((grant) => `${grant.capability}:${grant.name}`)
    .toSorted()

describe('allowing an App as a whole', () => {
  it('grants exactly the tools that declare the App, and its resource; nothing else', async () => {
    const mcp = await host()
    try {
      await mcp.setAppGrant('notes', BOARD, true)
      expect(allowed(mcp)).toEqual([`resource:${BOARD}`, 'tool:move', 'tool:open'])
      await mcp.setAppGrant('notes', BOARD, false)
      expect(allowed(mcp)).toEqual([])
    } finally {
      await mcp.manager.closeAll()
    }
  })
  it('refuses an App no tool declares', async () => {
    const mcp = await host()
    try {
      await expect(mcp.setAppGrant('notes', 'ui://notes/other.html', true)).rejects.toMatchObject({ _tag: 'NotFound' })
      expect(allowed(mcp)).toEqual([])
    } finally {
      await mcp.manager.closeAll()
    }
  })
})
