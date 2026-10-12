import { describe, expect, test } from 'vitest'
import { toHex } from '../balances/hex.ts'
import { field, type JsonRpc } from '../balances/rpc.ts'
import type { AgentSigner } from '../contract/index.ts'
import quoteFixture from './fixtures/base-tempo.json' with { type: 'json' }
import {
  depositStatus,
  executeBridge,
  quoteBridge,
  quoteDepositAddress,
  RELAY_DEPOSITORY,
  relayDelivery,
  type FrozenBridge,
} from './index.ts'
import { BASE } from '../chains/index.ts'

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

/** The fixture as if Relay had quoted Arbitrum USDC as the destination. */
const toArbitrum = {
  ...quoteFixture,
  details: {
    ...quoteFixture.details,
    currencyOut: {
      ...quoteFixture.details.currencyOut,
      currency: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', chainId: 42161 },
    },
  },
}

/** The fixture with one step's calldata rewritten. */
const withStepData = (index: number, rewrite: (data: string) => string) => {
  const steps = structuredClone(quoteFixture.steps)
  const item = steps[index]?.items[0]
  if (item) item.data.data = rewrite(item.data.data)
  return { ...quoteFixture, steps }
}

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
        return Response.json(toArbitrum)
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

  test('decodes the steps: the approval and the deposit must be exactly the amount, from the agent, in USDC', async () => {
    await expect(quote(withStepData(1, (data) => data.replace('1e8480', '1e8481')))).rejects.toThrow(
      /quoted amount of USDC from the agent/u,
    )
    await expect(quote(withStepData(0, (data) => data.replace('1e8480', '0f4240')))).rejects.toThrow(/exact amount/u)
    const stranger = AGENT.slice(2).toLowerCase()
    await expect(quote(withStepData(1, (data) => data.replace(stranger, '11'.repeat(20))))).rejects.toThrow(
      /from the agent/u,
    )
    await expect(quote(withStepData(1, (data) => `0xa9059cbb${data.slice(10)}`))).rejects.toThrow(/does not run/u)
  })

  test('refuses a missing USD valuation and a destination currency that is not the requested one', async () => {
    const { amountUsd: _dropped, ...currencyIn } = quoteFixture.details.currencyIn
    await expect(quote({ ...quoteFixture, details: { ...quoteFixture.details, currencyIn } })).rejects.toThrow(
      /no USD value/u,
    )
    await expect(quote(toArbitrum)).rejects.toThrow(/does not restate/u)
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

/** A quiet Base fee market: 100k gas at 0.01 gwei. */
const FEES: Record<string, unknown> = {
  eth_estimateGas: '0x186a0',
  eth_getBlockByNumber: { baseFeePerGas: '0x989680' },
  eth_maxPriorityFeePerGas: '0x186a0',
}

const BALANCE_OF = '0x70a08231'
const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`

/** A Base node; the agent holds `usdc` base units (10 USDC unless told otherwise). */
const nodeWith =
  (usdc: bigint): JsonRpc =>
  async (method, params) => {
    if (method === 'eth_getTransactionReceipt') return { status: '0x1' }
    if (method === 'eth_getBalance') return word(10n ** 15n)
    if (method in FEES) return FEES[method]
    if (method === 'eth_call') return String(field(params[0], 'data')).startsWith(BALANCE_OF) ? word(usdc) : '0x'
    throw new Error(`unexpected ${String(field({}, 'x'))}${method}`)
  }

const fakeRpc = nodeWith(10_000_000n)

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

  test('re-checks the frozen steps before signing: a tampered deposit sends nothing', async () => {
    const bridge = await quote()
    const steps = bridge.steps.map((step) =>
      step.id === 'deposit' ? { ...step, data: step.data.replace('1e8480', '989680') } : step,
    )
    const h = harness()
    await expect(run({ ...bridge, steps }, h, [])).rejects.toMatchObject({ code: 'bad_quote' })
    expect(h.sent).toHaveLength(0)
  })

  test('an empty agent signs nothing; with an allowance it redeems the deposit first', async () => {
    const bridge = await quote()
    const empty = { ...harness(), rpc: nodeWith(0n) }
    await expect(run(bridge, empty, ['success'])).rejects.toMatchObject({ code: 'insufficient_funds' })
    expect(empty.sent).toEqual([])
    let redeemed = false
    const node = nodeWith(0n)
    const funded = {
      ...harness(),
      rpc: (async (method, params) =>
        redeemed && method === 'eth_call' && String(field(params[0], 'data')).startsWith(BALANCE_OF)
          ? word(10_000_000n)
          : node(method, params)) satisfies JsonRpc,
    }
    const topUp = {
      redeemCalldata: () => {
        redeemed = true
        return '0xfeed' as const
      },
      available: async () => 20_000_000n,
    }
    const result = await executeBridge({
      bridge,
      agent: funded.agent,
      rpc: funded.rpc,
      operationKey: 'op-bridge-0001',
      topUp,
      wait: { sleep: async () => undefined, attempts: 2 },
      fetchFn: statusFetch(['success']),
      sleep: async () => undefined,
      statusAttempts: 3,
      now: () => NOW,
    })
    expect(result.status).toBe('success')
    expect(funded.sent.map((s) => s.key)).toEqual([
      'op-bridge-0001:topup',
      'op-bridge-0001:approve',
      'op-bridge-0001:deposit',
    ])
  })

  test('refuses an expired quote without sending', async () => {
    const h = harness()
    await expect(run(await quote(), h, [], new Date('2026-10-12T06:10:00Z'))).rejects.toMatchObject({ code: 'expired' })
    expect(h.sent).toHaveLength(0)
  })
})

/** Relay's keyless status API refusing: it rate-limits in stages. */
const rateLimited = async () => Response.json({ message: 'rate limit' }, { status: 429 })

/** A Relay `requests/v2` answer holding one fill with this status. */
const fillAt = (status: string) => async () =>
  Response.json({
    requests: [{ status, data: { inTxs: [{ hash: '0xab' }], outTxs: [{ hash: '0xcd' }, { hash: 'nope' }] } }],
  })

describe('deposit addresses', () => {
  const OWNER = '0x76C70140b195ABcFf6406D0a83f8b64A2d435e94'
  const relayQuote = {
    steps: [{ id: 'deposit', depositAddress: '0xc9b1672f6fbc38f66d775bb9a5d46b8f0dd2613f', requestId: '0x1791' }],
    details: { currencyOut: { amount: '10158603' }, timeEstimate: 2 },
    fees: { relayer: { amountUsd: '0.032409' }, gas: { amountUsd: '0.001' } },
  }

  test('quotes a one-off address that delivers to the owner on Base, refunding to the owner', async () => {
    const sent: unknown[] = []
    const deposit = await quoteDepositAddress({
      from: 'base',
      asset: 'ETH',
      amount: '0.004',
      receive: 'USDC',
      recipient: OWNER,
      fetchFn: async (_url, init) => {
        sent.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'))
        return Response.json(relayQuote)
      },
    })
    expect(deposit).toEqual({
      requestId: '0x1791',
      depositAddress: '0xc9b1672f6fbc38f66d775bb9a5d46b8f0dd2613f',
      expectedOut: '10.158603',
      feesUsd: '0.033409',
      timeEstimateSeconds: 2,
    })
    expect(sent[0]).toMatchObject({
      recipient: OWNER,
      refundTo: OWNER,
      originChainId: 8453,
      destinationChainId: 8453,
      originCurrency: '0x0000000000000000000000000000000000000000',
      destinationCurrency: BASE.usdc.address,
      amount: '4000000000000000',
      useDepositAddress: true,
    })
  })

  test('refuses a same-asset deposit on Base and a quote without an address', async () => {
    await expect(
      quoteDepositAddress({ from: 'base', asset: 'USDC', amount: '5', receive: 'USDC', recipient: OWNER }),
    ).rejects.toMatchObject({ code: 'unsupported' })
    await expect(
      quoteDepositAddress({
        from: 'arbitrum',
        asset: 'USDC',
        amount: '5',
        receive: 'USDC',
        recipient: OWNER,
        fetchFn: async () => Response.json({ steps: [{}] }),
      }),
    ).rejects.toMatchObject({ code: 'bad_quote' })
  })

  test('follows the deposit address: no fill yet is waiting, then Relay statuses map to the owner API words', async () => {
    const address = '0xc9b1672f6fbc38f66d775bb9a5d46b8f0dd2613f'
    expect(await depositStatus(address, async () => Response.json({ requests: [] }))).toEqual({
      status: 'waiting',
      txHashes: [],
    })
    expect(await depositStatus(address, fillAt('success'))).toEqual({ status: 'success', txHashes: ['0xab', '0xcd'] })
    expect((await depositStatus(address, fillAt('refund'))).status).toBe('refunded')
    expect((await depositStatus(address, fillAt('failure'))).status).toBe('failed')
    expect((await depositStatus(address, fillAt('delayed'))).status).toBe('pending')
    expect(await depositStatus(address, rateLimited)).toEqual({ status: 'unknown', txHashes: [] })
  })
})
