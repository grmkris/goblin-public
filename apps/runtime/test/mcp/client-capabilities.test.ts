import { CLIENT_CAPABILITIES_META_KEY, createMcpHandler } from '@modelcontextprotocol/server'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { CLIENT_CAPABILITIES } from '../../src/mcp/remote.ts'
import { managerOf } from './manager.ts'
import { MemoryGrants } from './memory.ts'
import { lowLevelServer } from './low-level-server.ts'

const Envelope = Schema.Struct({
  [CLIENT_CAPABILITIES_META_KEY]: Schema.Record(Schema.String, Schema.Unknown),
})

const MCP_APPS = 'io.modelcontextprotocol/ui'

describe('the client capabilities goblin declares (unit)', () => {
  it('declares the MCP Apps extension with the one App MIME type, beside Skills and Events', () => {
    expect(CLIENT_CAPABILITIES.extensions[MCP_APPS]).toEqual({ mimeTypes: ['text/html;profile=mcp-app'] })
    expect(Object.keys(CLIENT_CAPABILITIES.extensions)).toEqual(
      expect.arrayContaining(['io.modelcontextprotocol/skills', 'io.modelcontextprotocol/events', MCP_APPS]),
    )
  })

  it('sends it on the wire: in the per-request envelope of a call, with URL elicitation added on a model call', async () => {
    const seen: Array<{ extensions: Record<string, unknown>; elicitation: unknown }> = []
    const official = createMcpHandler(() => {
      const server = lowLevelServer({ name: 'caps', version: '1.0.0' }, { capabilities: { tools: {} } })
      server.setRequestHandler('tools/list', () => ({
        tools: [{ name: 'read', inputSchema: { type: 'object' as const, properties: {} } }],
      }))
      server.setRequestHandler('tools/call', (_request, ctx) => {
        const decoded = Schema.decodeUnknownOption(Envelope)(ctx.mcpReq.envelope)
        const caps = Option.isSome(decoded) ? decoded.value[CLIENT_CAPABILITIES_META_KEY] : {}
        const extensions = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))(caps['extensions'])
        seen.push({ extensions: Option.getOrElse(extensions, () => ({})), elicitation: caps['elicitation'] })
        return { content: [{ type: 'text', text: 'ok' }] }
      })
      return server
    })
    const manager = managerOf({
      servers: [{ connectionId: 'caps', endpoint: 'https://caps.test/mcp' }],
      allows: (grant) => new MemoryGrants([{ connectionId: 'caps', capability: 'tool', name: 'read' }]).allows(grant),
      auth: () => ({ token: async () => 'fixture' }),
      fetch: async (input, init) => official.fetch(new Request(input, init)),
    })
    try {
      await manager.connections.callTool('caps', 'read', {}, { caller: 'human' })
      await manager.connections.callModelTool('caps', 'read', {})
      expect(seen).toHaveLength(2)
      for (const call of seen) expect(call.extensions[MCP_APPS]).toEqual({ mimeTypes: ['text/html;profile=mcp-app'] })
      expect(seen[0]?.elicitation).toBeUndefined()
      expect(seen[1]?.elicitation).toEqual({ url: {} })
    } finally {
      await manager.dispose()
    }
  })
})
