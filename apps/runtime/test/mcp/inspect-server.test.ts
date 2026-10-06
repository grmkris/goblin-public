import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import type { InspectQuery } from '@goblin/contracts/inspect'
import { describe, expect, it } from 'vitest'
import { NotFound } from '../../src/http/errors.ts'
import { type InspectReader, inspectServer } from '../../src/inbound/inspect-server.ts'

type Read = { readonly query: InspectQuery; readonly user: string | undefined }

const connect = async (reader: InspectReader, operator: boolean) => {
  const handler = createMcpHandler(() => inspectServer(reader, operator))
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL('https://goblin.test/mcp/inspect'), {
      fetch: async (input, init) => handler.fetch(new Request(input, init)),
    }),
  )
  return client
}
const turns = { turns: [] }

describe('inspection MCP server (unit, ADR 0024)', () => {
  it('lists five read-only tools with input and output schemas, and passes queries through', async () => {
    const reads: Read[] = []
    const client = await connect(
      {
        read: async (query, user) => {
          reads.push({ query, user })
          return turns
        },
      },
      false,
    )
    try {
      const { tools } = await client.listTools()
      expect(tools.map((tool) => tool.name)).toEqual([
        'inspect_conversations',
        'inspect_conversation',
        'inspect_turns',
        'inspect_turn',
        'inspect_problems',
      ])
      for (const tool of tools) {
        expect(tool.annotations?.readOnlyHint, tool.name).toBe(true)
        expect(tool.outputSchema, tool.name).toMatchObject({ type: 'object' })
      }
      expect(tools.find((tool) => tool.name === 'inspect_turn')?.inputSchema).toMatchObject({
        required: ['operationId'],
      })
      const result = await client.callTool({ name: 'inspect_turns', arguments: { limit: 5 } })
      expect(result.structuredContent).toEqual(turns)
      expect(reads).toEqual([{ query: { kind: 'turns', limit: 5 }, user: undefined }])
      const bad = await client.callTool({ name: 'inspect_turns', arguments: { limit: 500 } })
      expect(bad.isError).toBe(true)
      expect(reads).toHaveLength(1)
    } finally {
      await client.close()
    }
  })

  it('names the error a read failed with, and nothing else', async () => {
    const client = await connect(
      {
        read: async () => {
          throw new NotFound({ what: 'turn' })
        },
      },
      false,
    )
    try {
      const result = await client.callTool({ name: 'inspect_turn', arguments: { operationId: 'missing' } })
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: '{"_tag":"NotFound","what":"turn"}' }],
      })
    } finally {
      await client.close()
    }
  })

  it('needs a user on every operator tool and offers the operator their own reads', async () => {
    const reads: Read[] = []
    const client = await connect(
      {
        read: async (query, user) => {
          reads.push({ query, user })
          return { conversations: [] }
        },
        reads: async (limit) => ({ reads: [{ at: limit, user: 'u', clientId: 'c', tool: 't', arguments: '{}' }] }),
      },
      true,
    )
    try {
      const { tools } = await client.listTools()
      expect(tools.map((tool) => tool.name)).toContain('operator_reads')
      expect(tools.find((tool) => tool.name === 'inspect_conversations')?.inputSchema).toMatchObject({
        required: ['user'],
      })
      expect((await client.callTool({ name: 'inspect_conversations', arguments: {} })).isError).toBe(true)
      const ok = await client.callTool({ name: 'inspect_conversations', arguments: { user: 'a@b.test' } })
      expect(ok.structuredContent).toEqual({ conversations: [] })
      expect(reads).toEqual([{ query: { kind: 'conversations' }, user: 'a@b.test' }])
      const own = await client.callTool({ name: 'operator_reads', arguments: { limit: 3 } })
      expect(own.structuredContent).toMatchObject({ reads: [{ at: 3 }] })
    } finally {
      await client.close()
    }
  })
})
