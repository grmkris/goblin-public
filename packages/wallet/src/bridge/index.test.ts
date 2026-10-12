import { describe, expect, test } from 'vitest'
import type { TopUp } from '../balances/transfer.ts'
import { fakeBundler, fakeNode, localAgent, TEST_FEE_BOUND } from '../bundler/testing.ts'
import recorded from './fixtures/base-tempo.json' with { type: 'json' }
import {
  depositStatus,
  executeBridge,
  quoteBridge,
  quoteDepositAddress,
  RELAY_DEPOSITORY,
  relayDelivery,
  type FrozenBridge,
} from './index.ts'
import { ARBITRUM, BASE, TEMPO } from '../chains/index.ts'

/** The recorded quote was for another agent; it is re-addressed to a local account so its operations really sign. */
const signer = localAgent()
const AGENT = signer.address
const quoteFixture: typeof recorded = JSON.parse(
  JSON.stringify(recorded).replaceAll(/03582783c8e71b0c2D3b607E0FBdec7402f76F77/giu, AGENT.slice(2).toLowerCase()),
)
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

const lower = (call: { target: string; callData: string }) => [call.target.toLowerCase(), call.callData.toLowerCase()]

const harness = (usdc = 10_000_000n) => ({ bundler: fakeBundler(), rpc: fakeNode({ usdc: () => usdc }) })

const statusFetch = (statuses: string[]) => async () =>
  Response.json({ status: statuses.shift() ?? 'pending', txHashes: [`0x${'cd'.repeat(32)}`] })

const run = (bridge: FrozenBridge, h: ReturnType<typeof harness>, statuses: string[], now = NOW, topUp?: TopUp) =>
  executeBridge({
    bridge,
    live: true,
    agent: signer,
    rpc: h.rpc,
    bundler: h.bundler.rpc,
    operationKey: 'op-bridge-0001',
    wait: { sleep: async () => undefined, attempts: 2 },
    fetchFn: statusFetch(statuses),
    sleep: async () => undefined,
    statusAttempts: 3,
    now: () => now,
    ...(topUp === undefined ? {} : { topUp }),
  })

describe('Relay bridge execute', () => {
  test('one operation: the approval and the deposit, unchanged; delivery reported once Relay says success', async () => {
    const bridge = await quote()
    const h = harness()
    const result = await run(bridge, h, ['waiting', 'pending', 'success'])
    const [batch] = h.bundler.batches
    expect(batch?.slice(0, 2).map(lower)).toEqual(
      bridge.steps.map((step) => [step.to.toLowerCase(), step.data.toLowerCase()]),
    )
    expect(batch?.length).toBe(3)
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
    expect(h.bundler.methods).toHaveLength(0)
  })

  test('an empty agent sends nothing; with an allowance it redeems the deposit plus the gas in the same operation', async () => {
    const bridge = await quote()
    const empty = harness(0n)
    await expect(run(bridge, empty, ['success'])).rejects.toMatchObject({ code: 'insufficient_funds' })
    expect(empty.bundler.methods).not.toContain('eth_sendUserOperation')
    const asked: bigint[] = []
    const topUp: TopUp = {
      redeemCalldata: (amount) => {
        asked.push(amount)
        return '0xfeed'
      },
      available: async () => 20_000_000n,
    }
    const funded = harness(0n)
    const result = await run(bridge, funded, ['success'], NOW, topUp)
    expect(result.status).toBe('success')
    expect(asked.at(-1)).toBe(2_000_000n + TEST_FEE_BOUND)
    expect(funded.bundler.batches[0]?.[0]).toEqual({ target: BASE.delegation.manager, value: 0n, callData: '0xfeed' })
  })

  test('refuses an expired quote without sending', async () => {
    const h = harness()
    await expect(run(await quote(), h, [], new Date('2026-10-12T06:10:00Z'))).rejects.toMatchObject({ code: 'expired' })
    expect(h.bundler.methods).toHaveLength(0)
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

  test('quotes USDC.e on Tempo for the agent from any origin, refunding to the agent', async () => {
    const sent: unknown[] = []
    const deposit = await quoteDepositAddress({
      from: 'arbitrum',
      asset: 'USDC',
      amount: '2',
      receive: 'USDC.e',
      recipient: AGENT,
      fetchFn: async (_url, init) => {
        sent.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'))
        return Response.json({ ...relayQuote, details: { currencyOut: { amount: '1966555' }, timeEstimate: 1 } })
      },
    })
    expect(deposit).toMatchObject({ expectedOut: '1.966555', timeEstimateSeconds: 1 })
    expect(sent[0]).toMatchObject({
      recipient: AGENT,
      refundTo: AGENT,
      originChainId: 42161,
      destinationChainId: TEMPO.id,
      originCurrency: ARBITRUM.usdc.address,
      destinationCurrency: TEMPO.usdc.address,
      amount: '2000000',
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
