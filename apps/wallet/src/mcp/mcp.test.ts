import { DatabaseSync } from 'node:sqlite'
import * as Schema from 'effect/Schema'
import { describe, expect, test } from 'vitest'
import { unconfiguredRails, type Wiring } from '../context.ts'
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
    Promise.resolve([
      { chain: 'base', symbol: 'USDC', token: USDC, decimals: 6, balance: '12.5', holder: 'owner', address: OWNER },
    ]),
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
    scopes: ['wallet'],
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
    expect(result.structuredContent).toMatchObject({
      status: { kind: 'wallet', funding: 'ready', paid: 'blocked' },
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
