import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import type { AskResult } from '@goblin/contracts/internal'
import { SubscriptionRequired } from '../../src/http/errors.ts'
import { type ClientAgentPort, inboundServer } from '../../src/inbound/server.ts'

const connect = async (agent: ClientAgentPort) => {
  const handler = createMcpHandler(() => inboundServer(agent))
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL('https://goblin.test/mcp'), {
      fetch: async (input, init) => handler.fetch(new Request(input, init)),
    }),
  )
  return client
}
const textOf = (result: unknown): unknown => {
  // SAFETY: these tools return exactly one text block (src/inbound/tools.ts `text` and `failed`).
  const content = (result as { content: readonly { text: string }[] }).content
  return JSON.parse(content[0]?.text ?? 'null')
}

describe('goblin inbound MCP server (unit)', () => {
  it('exposes only ask_agent and get_recent_messages to a client without goblin:inspect', async () => {
    const client = await connect({ ask: async () => ({ status: 'running', operationId: 'x' }), recent: async () => [] })
    try {
      const { tools } = await client.listTools()
      expect(tools.map((tool) => tool.name).toSorted()).toEqual(['ask_agent', 'get_recent_messages'])
      const ask = tools.find((tool) => tool.name === 'ask_agent')
      expect(ask?.inputSchema).toMatchObject({ type: 'object', required: ['input'] })
      expect(client.getInstructions()).not.toContain('inspect_')
    } finally {
      await client.close()
    }
  })
  it('adds the seven inspection tools for a client holding goblin:inspect', async () => {
    const client = await connect({
      ask: async () => ({ status: 'running', operationId: 'x' }),
      recent: async () => [],
      inspect: async () => ({}),
    })
    try {
      const { tools } = await client.listTools()
      expect(tools).toHaveLength(9)
      expect(tools.filter((tool) => tool.name.startsWith('inspect_'))).toHaveLength(7)
    } finally {
      await client.close()
    }
  })
  it('refuses ask_agent with the error that stopped it, while reading still works', async () => {
    const client = await connect({
      ask: async () => {
        throw new SubscriptionRequired({ subscribe: '/subscribe' })
      },
      recent: async () => [{ role: 'user', text: 'hi' }],
    })
    try {
      const refused = await client.callTool({ name: 'ask_agent', arguments: { input: 'ping' } })
      expect(refused.isError).toBe(true)
      expect(textOf(refused)).toEqual({ _tag: 'SubscriptionRequired', subscribe: '/subscribe' })
      const recent = await client.callTool({ name: 'get_recent_messages', arguments: {} })
      expect(textOf(recent)).toEqual({ messages: [{ role: 'user', text: 'hi' }] })
    } finally {
      await client.close()
    }
  })
  it('passes the question to the agent with a bounded wait and returns its answer', async () => {
    const calls: { input: string; operationId: string; waitMs: number }[] = []
    const answer: AskResult = { status: 'done', operationId: 'op-1', text: 'pong' }
    const client = await connect({
      ask: async (input, operationId, waitMs) => {
        calls.push({ input, operationId, waitMs })
        return answer
      },
      recent: async (limit) => [{ role: 'assistant', text: `limit ${limit}` }],
    })
    try {
      const result = await client.callTool({ name: 'ask_agent', arguments: { input: 'ping', operationId: 'op-1' } })
      expect(textOf(result)).toEqual(answer)
      expect(calls).toEqual([{ input: 'ping', operationId: 'op-1', waitMs: 50_000 }])
      const tooLong = await client.callTool({ name: 'ask_agent', arguments: { input: 'ping', waitSeconds: 600 } })
      expect(tooLong.isError).toBe(true)
      const recent = await client.callTool({ name: 'get_recent_messages', arguments: { limit: 5 } })
      expect(textOf(recent)).toEqual({ messages: [{ role: 'assistant', text: 'limit 5' }] })
    } finally {
      await client.close()
    }
  })
})
