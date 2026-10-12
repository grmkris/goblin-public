import { createMcpHandler } from '@modelcontextprotocol/server'
import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'
import {
  allowRecommended,
  raiseRule,
  serverStatus,
  setSpending,
  spendingView,
} from '../../src/mcp/first-class-owner.ts'
import { lowLevelServer } from './low-level-server.ts'
import { hostOf } from './manager.ts'
import * as Layer from 'effect/Layer'
import { spendingOver } from '../../src/layers/mcp.ts'
import { Spending } from '../../src/mcp/service.ts'
import { SpendStore } from '../../src/mcp/spend.ts'
import { chatDatabase, durable } from '../chats-sqlite.ts'
import { MemoryCredentials, MemoryGrants } from './memory.ts'

const MERCATOR = { connectionId: 'mercator', endpoint: 'https://mercator.sh/mcp/auth', label: 'Mercator' }

/** A Mercator-like server: its free tools, its paid `create_job`, and a wallet status; it does not list `list_jobs`. */
const mercator = createMcpHandler(() => {
  const server = lowLevelServer({ name: 'mercator', version: '0.5.0' }, { capabilities: { tools: {} } })
  const names = ['get_connection_status', 'search_services', 'describe_service', 'quote_plan', 'get_job', 'create_job']
  server.setRequestHandler('tools/list', () => ({
    tools: names.map((name) => ({ name, inputSchema: { type: 'object' as const, properties: {} } })),
  }))
  server.setRequestHandler('tools/call', () => ({
    content: [{ type: 'text', text: 'ready' }],
    structuredContent: {
      readiness: { funding: 'ready', paidExecution: 'ready', tokens: [{ symbol: 'USDC.e', balance: '3.2' }] },
      next_action: 'Ready.',
    },
  }))
  return server
})

const host = async () => {
  const credentials = new MemoryCredentials()
  await credentials.saveTokens('mercator', { access_token: 'fixture', token_type: 'bearer' }, 0)
  return hostOf({
    servers: [MERCATOR],
    credentials,
    grants: new MemoryGrants(),
    fetch: async (input, init) => mercator.fetch(new Request(input, init)),
  })
}

describe('what the owner does with a first-class server (ADR 0043)', () => {
  it('allows the recommended tools in one go: the free ones run when needed, the paid one asks first', async () => {
    const mcp = await host()
    try {
      const grants = await mcp.run(allowRecommended('mercator'))
      const tools = grants.filter((grant) => grant.capability === 'tool')
      expect(tools.map((grant) => grant.name).toSorted()).toEqual([
        'create_job',
        'describe_service',
        'get_connection_status',
        'get_job',
        'quote_plan',
        'search_services',
      ])
      expect(tools.find((grant) => grant.name === 'create_job')?.askFirst).toBe(true)
      expect(tools.filter((grant) => grant.askFirst).map((grant) => grant.name)).toEqual(['create_job'])
    } finally {
      await mcp.dispose()
    }
  })

  it('reads its wallet only once its status tool is allowed, and refuses a server it has no profile for', async () => {
    const mcp = await host()
    try {
      expect(await mcp.run(serverStatus('mercator'))).toBeNull()
      await mcp.run(allowRecommended('mercator'))
      expect(await mcp.run(serverStatus('mercator'))).toEqual({
        kind: 'wallet',
        paid: 'ready',
        funding: 'ready',
        tokens: [{ symbol: 'USDC.e', balance: '3.2' }],
      })
      await expect(mcp.run(serverStatus('nowhere'))).rejects.toMatchObject({ _tag: 'NotFound' })
    } finally {
      await mcp.dispose()
    }
  })

  it("sets and reads the paid tool's rule, and approving with 'up to' starts a daily total at four times the amount", async () => {
    const mcp = await host()
    const { db, close } = chatDatabase()
    const spending = Layer.succeed(Spending, spendingOver(new SpendStore(durable(db))))
    const run = <A, E, R>(program: Effect.Effect<A, E, R>) =>
      // SAFETY: the spending programs need only the host's services and Spending.
      mcp.run(Effect.provide(program, spending) as Effect.Effect<A, E>)
    try {
      expect(await run(spendingView('mercator'))).toEqual({ tool: 'create_job', spentToday: '0' })
      await run(raiseRule('mercator', 'create_job', '5'))
      expect(await run(spendingView('mercator'))).toMatchObject({ perJob: '5', daily: '20' })
      expect(await run(setSpending('mercator', { perJob: '2.5', daily: null }))).toEqual({
        tool: 'create_job',
        perJob: '2.5',
        spentToday: '0',
      })
      expect(await run(setSpending('mercator', { perJob: null, daily: null }))).toEqual({
        tool: 'create_job',
        spentToday: '0',
      })
      // Raising the rule is only for the profile's paid tool.
      await run(raiseRule('mercator', 'search_services', '5'))
      expect(await run(spendingView('mercator'))).not.toHaveProperty('perJob')
    } finally {
      close()
      await mcp.dispose()
    }
  })
})
