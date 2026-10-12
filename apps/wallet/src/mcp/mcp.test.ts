import { DatabaseSync } from 'node:sqlite'
import * as Schema from 'effect/Schema'
import { describe, expect, test } from 'vitest'
import { defaultWiring, unconfiguredRails, type Wiring } from '../context.ts'
import { WalletLedger } from '../ledger/durable.ts'
import type { RailsPort } from '../services/rails.ts'
import { testEnv } from '../test-env.ts'
import { type McpAuthenticator, challenge } from './auth.ts'
import { createMcpEndpoint } from './handler.ts'

const ledgerFor = () => {
  const db = new DatabaseSync(':memory:')
  return new WalletLedger({
    storage: {
      sql: { exec: (query, ...bindings) => ({ toArray: () => db.prepare(query).all(...bindings) }) },
      transactionSync: (write) => write(),
    },
  })
}

const OWNER = '0x1111111111111111111111111111111111111111'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const rails: RailsPort = {
  ...unconfiguredRails,
  balances: () =>
    Promise.resolve({
      balances: [
        { chain: 'base', symbol: 'USDC', token: USDC, decimals: 6, balance: '12.5', holder: 'owner', address: OWNER },
      ],
      unread: [],
    }),
  allowances: () =>
    Promise.resolve([
      {
        layer: 'onchain',
        period: 'hour',
        limit: '20',
        remaining: '20',
        chain: 'base',
        enforcedBy: 'MetaMask ERC20PeriodTransfer',
      },
    ]),
}
const ledgers = new Map<string, WalletLedger>()
const wiring: Wiring = {
  ...defaultWiring,
  ledger: (_env, owner) => {
    const ledger = ledgers.get(owner.userId) ?? ledgerFor()
    ledgers.set(owner.userId, ledger)
    return ledger
  },
  signer: () => Promise.resolve(undefined),
  rails: () => rails,
}

const authenticate: McpAuthenticator = (request) => {
  if (request.headers.get('authorization') !== 'Bearer good') return Promise.resolve(challenge(request))
  return Promise.resolve({
    ownerUserId: 'did:privy:owner1',
    clientId: 'c1',
    clientName: 'Test client',
    scopes: ['wallet:read', 'wallet:spend'],
    token: 'good',
  })
}

const endpoint = createMcpEndpoint({ authenticate, wiring })
const rpc = (method: string, params: unknown, headers: Record<string, string> = { authorization: 'Bearer good' }) =>
  endpoint(
    new Request('https://wallet.test/mcp', {
      method: 'POST',
      headers: {
        host: 'wallet.test',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
    testEnv(),
  )

const Result = Schema.Struct({
  result: Schema.Struct({
    tools: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
    content: Schema.optional(Schema.Array(Schema.Struct({ text: Schema.String }))),
    structuredContent: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    isError: Schema.optional(Schema.Boolean),
  }),
})
const decode = Schema.decodeUnknownSync(Result)

const resultOf = async (response: Response) => {
  const body = await response.text()
  const data = body.startsWith('event:')
    ? (body.split('\n').find((line) => line.startsWith('data:')) ?? '').slice(5)
    : body
  return decode(JSON.parse(data)).result
}
const call = (name: string, args: Record<string, unknown> = {}) =>
  rpc('tools/call', { name, arguments: args }).then(resultOf)

describe('the MCP endpoint', () => {
  test('answers the challenge without a token', async () => {
    const response = await rpc('tools/list', {}, {})
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=')
  })

  test('refuses a browser page on another origin', async () => {
    const response = await rpc('tools/list', {}, { authorization: 'Bearer good', origin: 'https://evil.example' })
    expect(response.status).toBe(403)
  })

  test('lists the read tools', async () => {
    const result = await rpc('tools/list', {}).then(resultOf)
    expect(result.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['wallet_status', 'balances', 'allowances', 'services', 'operation', 'receipt']),
    )
  })

  test("wallet_status returns goblin's WalletStatus shape with a text fallback", async () => {
    const result = await call('wallet_status')
    expect(result.content?.[0]?.text).toContain('Wallet: paid blocked, funding ready')
    expect(result.content?.[0]?.text).toContain('Stablecoins held by the owner and the agent: $12.5.')
    expect(result.structuredContent).toMatchObject({
      status: { kind: 'wallet', funding: 'ready', paid: 'blocked', stablecoinUsd: '12.5' },
    })
  })

  test('allowances names the layer of each limit', async () => {
    const result = await call('allowances')
    expect(result.structuredContent).toMatchObject({
      limits: expect.arrayContaining([
        expect.objectContaining({ layer: 'ledger' }),
        expect.objectContaining({ layer: 'onchain' }),
      ]),
    })
  })

  test('services lists the built-in allowlist', async () => {
    const result = await call('services')
    expect(result.structuredContent).toMatchObject({
      services: [expect.objectContaining({ id: 'exa.search' }), expect.anything()],
    })
  })

  test('operation reports an unknown id as a refusal', async () => {
    const result = await call('operation', { operation_id: 'op-unknown-1' })
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: 'unknown_operation' } } })
  })
})

describe('the paid tools over MCP', () => {
  const quoting: RailsPort = {
    ...rails,
    quotePaidFetch: () =>
      Promise.resolve({
        kind: 'paid_fetch',
        chain: 'base',
        rail: 'x402',
        subject: 'exa.search',
        token: { symbol: 'USDC', address: USDC, decimals: 6 },
        amount: '0.007',
        amountUsd: '0.007',
        recipient: OWNER,
        request: { method: 'POST', url: 'https://api.exa.ai/search' },
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }),
    payPaidFetch: () =>
      Promise.resolve({
        outcome: 'settled',
        payment: { rail: 'x402', reference: 'r1' },
        delivery: { status: 'ok' },
        response: { status: 200, contentType: 'application/json', body: { results: ['a'] }, truncated: false },
      }),
    quoteTransfer: () =>
      Promise.resolve({
        kind: 'transfer',
        chain: 'base',
        rail: 'transfer',
        subject: 'transfer',
        token: { symbol: 'USDC', address: USDC, decimals: 6 },
        amount: '1',
        amountUsd: '1',
        recipient: '0x3333333333333333333333333333333333333333',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }),
  }
  const paying = createMcpEndpoint({ authenticate, wiring: { ...wiring, rails: () => quoting } })
  const callPaying = (name: string, args: Record<string, unknown>) =>
    paying(
      new Request('https://wallet.test/mcp', {
        method: 'POST',
        headers: {
          host: 'wallet.test',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer good',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }),
      testEnv(),
    ).then(resultOf)

  test('paid_fetch pays, returns the bounded response and the limits left', async () => {
    const result = await callPaying('paid_fetch', {
      service: 'exa.search',
      args: { query: 'x' },
      max_usd: '0.05',
      operation_id: 'op-mcp-fetch-1',
    })
    expect(result.content?.[0]?.text).toContain('delivered')
    expect(result.structuredContent).toMatchObject({
      operation: { status: 'delivered' },
      response: { status: 200 },
      limits: expect.arrayContaining([expect.objectContaining({ layer: 'ledger', period: 'hour' })]),
    })
  })

  test('a transfer to a new recipient answers with the approval link on a client that cannot be asked', async () => {
    const result = await callPaying('transfer', {
      chain: 'base',
      token: 'USDC',
      to: '0x3333333333333333333333333333333333333333',
      amount: '1',
      max_usd: '2',
      operation_id: 'op-mcp-xfer-01',
    })
    expect(result.isError).toBeUndefined()
    expect(result.content?.[0]?.text).toContain('https://wallet.test/approve/op-mcp-xfer-01')
    expect(result.structuredContent).toMatchObject({
      approveUrl: 'https://wallet.test/approve/op-mcp-xfer-01',
      operation: { status: 'awaiting_approval' },
    })
  })

  test('request_policy_change only records the ask', async () => {
    const result = await callPaying('request_policy_change', { change: 'raise hourly to $30', reason: 'big batch' })
    expect(result.structuredContent).toMatchObject({ request: { status: 'pending', client: 'Test client' } })
  })
})

describe('the App tools and views', () => {
  const ToolList = Schema.Struct({
    result: Schema.Struct({
      tools: Schema.Array(
        Schema.Struct({ name: Schema.String, _meta: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) }),
      ),
    }),
  })
  const listTools = async () => {
    const body = await (await rpc('tools/list', {})).text()
    const data = body.startsWith('event:')
      ? (body.split('\n').find((line) => line.startsWith('data:')) ?? '').slice(5)
      : body
    return Schema.decodeUnknownSync(ToolList)(JSON.parse(data)).result.tools
  }

  test('wallet_open carries the dashboard view and returns the status with recent spends', async () => {
    const tools = await listTools()
    expect(tools.find((tool) => tool.name === 'wallet_open')?._meta).toMatchObject({
      ui: { resourceUri: 'ui://goblin-wallet/dashboard' },
    })
    const result = await call('wallet_open')
    expect(result.structuredContent).toMatchObject({ status: { kind: 'wallet' }, recent: expect.any(Array) })
    expect(result.content?.[0]?.text).toContain('Wallet dashboard')
  })

  test('wallet_home is the same view as an app-only global entrypoint', async () => {
    const home = (await listTools()).find((tool) => tool.name === 'wallet_home')
    expect(home?._meta).toMatchObject({
      ui: { resourceUri: 'ui://goblin-wallet/dashboard', visibility: ['app'] },
      'openai/ui': { entrypoints: [{ type: 'global' }] },
    })
    expect((await call('wallet_home')).structuredContent).toMatchObject({ status: { kind: 'wallet' } })
  })

  test('the spending tools attach the receipt view', async () => {
    const tools = await listTools()
    for (const name of ['paid_fetch', 'transfer', 'swap_execute', 'bridge_execute'])
      expect(tools.find((tool) => tool.name === name)?._meta).toMatchObject({
        ui: { resourceUri: 'ui://goblin-wallet/receipt' },
      })
  })

  test('the views are read from the assets as text/html;profile=mcp-app', async () => {
    const body = await (await rpc('resources/read', { uri: 'ui://goblin-wallet/receipt' })).text()
    expect(body).toContain('text/html;profile=mcp-app')
    expect(body).toContain('asset')
  })

  test('view_state keeps bounded JSON and refuses a large one', async () => {
    expect((await call('view_state', { state: { tab: 'limits' } })).structuredContent).toEqual({
      state: { tab: 'limits' },
    })
    expect((await call('view_state')).structuredContent).toEqual({ state: { tab: 'limits' } })
    expect(await call('view_state', { state: { big: 'x'.repeat(9000) } })).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'view_state_too_large' } },
    })
  })
})
