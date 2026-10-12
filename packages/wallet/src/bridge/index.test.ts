import { describe, expect, test } from 'vitest'
import { toHex } from '../balances/hex.ts'
import { field, type JsonRpc } from '../balances/rpc.ts'
import type { AgentSigner } from '../contract/index.ts'
import quoteFixture from './fixtures/base-tempo.json' with { type: 'json' }
import { executeBridge, quoteBridge, RELAY_DEPOSITORY, relayDelivery, type FrozenBridge } from './index.ts'

const AGENT = '0x03582783c8e71b0c2D3b607E0FBdec7402f76F77'
const NOW = new Date('2026-10-12T06:00:00Z')

const relayFetch =
  (body: unknown = quoteFixture) =>
  async () =>
    Response.json(body)
const quote = (body?: unknown, overrides: { to?: 'tempo' | 'arbitrum'; recipient?: string } = {}) =>
  quoteBridge({
    from: 'base',
    to: overrides.to ?? 'tempo',
    token: 'USDC',
    amount: '2',
    agent: AGENT,
    ...(overrides.recipient === undefined ? {} : { recipient: overrides.recipient }),
    fetchFn: relayFetch(body),
    now: () => NOW,
  })

const never = async () => {
  throw new Error('no request expected')
}

describe('Relay bridge quote', () => {
  test('freezes the approve and deposit steps with amounts, fees and minimum received', async () => {
    const bridge = await quote()
    expect(bridge).toMatchObject({
      from: 'base',
      to: 'tempo',
      amountIn: '2000000',
      amountOut: '1979222',
      amountOutMin: '1912919',
      amountInUsd: '1.999568',
      feesUsd: '0.022035',
      recipient: AGENT,
      expiresAt: '2026-10-12T06:02:00.000Z',
    })
    expect(bridge.steps.map((step) => step.id)).toEqual(['approve', 'deposit'])
    expect(bridge.steps[1]?.to.toLowerCase()).toBe(RELAY_DEPOSITORY)
  })

  test('sends the destination, the agent as user and a slippage cap in the request', async () => {
    let body: Record<string, unknown> = {}
    await quoteBridge({
      from: 'base',
      to: 'arbitrum',
      token: 'USDC',
      amount: '2',
      agent: AGENT,
      slippageBps: 500,
      now: () => NOW,
      fetchFn: async (_url, init) => {
        body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}')
        return Response.json(quoteFixture)
      },
    })
    expect(body).toMatchObject({
      originChainId: 8453,
      destinationChainId: 42161,
      amount: '2000000',
      user: AGENT,
      slippageTolerance: '100',
      tradeType: 'EXACT_INPUT',
    })
  })

  test('refuses a quote that pays someone else, a step to another contract and an oversized approval', async () => {
    await expect(
      quote({
        ...quoteFixture,
        details: { ...quoteFixture.details, recipient: '0x0000000000000000000000000000000000000001' },
      }),
    ).rejects.toMatchObject({ code: 'bad_quote' })
    const steps = structuredClone(quoteFixture.steps)
    const deposit = steps[1]?.items[0]
    if (deposit) deposit.data.to = '0x0000000000000000000000000000000000000001'
    await expect(quote({ ...quoteFixture, steps })).rejects.toMatchObject({ code: 'bad_quote' })
    await expect(
      quoteBridge({
        from: 'base',
        to: 'tempo',
        token: 'USDC',
        amount: '1',
        agent: AGENT,
        fetchFn: relayFetch(),
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: 'bad_quote' })
  })

  test('refuses unsupported routes and tokens before any request', async () => {
    await expect(
      quoteBridge({ from: 'tempo', to: 'base', token: 'USDC', amount: '1', agent: AGENT, fetchFn: never }),
    ).rejects.toMatchObject({ code: 'unsupported' })
    await expect(
      quoteBridge({ from: 'base', to: 'base', token: 'USDC', amount: '1', agent: AGENT, fetchFn: never }),
    ).rejects.toMatchObject({ code: 'unsupported' })
    await expect(
      quoteBridge({ from: 'base', to: 'tempo', token: 'DAI', amount: '1', agent: AGENT, fetchFn: never }),
    ).rejects.toMatchObject({ code: 'unsupported' })
  })
})

const fakeRpc: JsonRpc = async (method) => {
  if (method === 'eth_getTransactionReceipt') return { status: '0x1' }
  if (method === 'eth_call') return '0x'
  throw new Error(`unexpected ${String(field({}, 'x'))}${method}`)
}

const harness = () => {
  const sent: { to: string; key: string }[] = []
  const agent: AgentSigner = {
    address: AGENT,
    signTypedData: () => Promise.reject(new Error('unused')),
    signAuthorization: () => Promise.reject(new Error('unused')),
    sendTransaction: async ({ to, operationKey }) => {
      sent.push({ to, key: operationKey })
      return toHex(`0x${sent.length.toString(16).padStart(64, '0')}`)
    },
  }
  const rpc = fakeRpc
  return { agent, rpc, sent }
}

const statusFetch = (statuses: string[]) => async () =>
  Response.json({ status: statuses.shift() ?? 'pending', txHashes: [`0x${'cd'.repeat(32)}`] })

const run = (bridge: FrozenBridge, h: ReturnType<typeof harness>, statuses: string[], now = NOW) =>
  executeBridge({
    bridge,
    agent: h.agent,
    rpc: h.rpc,
    operationKey: 'op-bridge-0001',
    wait: { sleep: async () => undefined, attempts: 2 },
    fetchFn: statusFetch(statuses),
    sleep: async () => undefined,
    statusAttempts: 3,
    now: () => now,
  })

describe('Relay bridge execute', () => {
  test('runs approve then deposit and reports delivery once Relay says success', async () => {
    const bridge = await quote()
    const h = harness()
    const result = await run(bridge, h, ['waiting', 'pending', 'success'])
    expect(h.sent.map((s) => s.key)).toEqual(['op-bridge-0001:approve', 'op-bridge-0001:deposit'])
    expect(result).toMatchObject({
      status: 'success',
      delivery: 'delivered',
      destinationTxHashes: [`0x${'cd'.repeat(32)}`],
    })
    expect(result.explorerUrl).toContain('https://basescan.org/tx/')
  })

  test('a deposit that Relay never finishes is pending, a refund is failed', async () => {
    const bridge = await quote()
    expect((await run(bridge, harness(), ['pending', 'pending', 'pending'])).delivery).toBe('pending')
    expect((await run(bridge, harness(), ['refunded'])).delivery).toBe('failed')
    expect((await relayDelivery('0x1', { fetchFn: async () => Response.json({ status: 'success' }) })).delivery).toBe(
      'delivered',
    )
  })

  test('refuses an expired quote without sending', async () => {
    const h = harness()
    await expect(run(await quote(), h, [], new Date('2026-10-12T06:10:00Z'))).rejects.toMatchObject({ code: 'expired' })
    expect(h.sent).toHaveLength(0)
  })
})
