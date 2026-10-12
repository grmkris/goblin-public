import { decodeFunctionData, parseAbi } from 'viem'
import { describe, expect, test } from 'vitest'
import { toHex } from '../balances/hex.ts'
import { field, type JsonRpc } from '../balances/rpc.ts'
import type { AgentSigner } from '../contract/index.ts'
import quoteFixture from './fixtures/base-usdc-eth.json' with { type: 'json' }
import { executeSwap, LIFI_DIAMOND, quoteSwap, SwapError, type FrozenSwap } from './index.ts'

const AGENT = '0x03582783c8e71b0c2D3b607E0FBdec7402f76F77'
const OTHER = '0x2222222222222222222222222222222222222222'
const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`
const NOW = new Date('2026-10-12T06:00:00Z')
const erc20 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])

const fetchQuote =
  (body: unknown = quoteFixture) =>
  async () =>
    Response.json(body)

const quote = (body?: unknown) =>
  quoteSwap({ sell: 'USDC', buy: 'ETH', amount: '1', agent: AGENT, fetchFn: fetchQuote(body), now: () => NOW })

const AGENT_WORD = AGENT.slice(2).toLowerCase()
const withRequest = (patch: Record<string, unknown>) => ({
  ...quoteFixture,
  transactionRequest: { ...quoteFixture.transactionRequest, ...patch },
})

describe('LI.FI quote', () => {
  test('freezes the quote with the exact transaction, minimum received and fees', async () => {
    const swap = await quote()
    expect(swap).toMatchObject({
      chain: 'base',
      sellAmount: '1000000',
      buyAmountMin: '390354582961072',
      approvalAddress: LIFI_DIAMOND,
      transaction: { to: LIFI_DIAMOND, value: '0x0', chainId: 8453 },
      sellUsd: '0.9964',
      feesUsd: '0.0067',
      expiresAt: '2026-10-12T06:01:30.000Z',
    })
    expect(swap.transaction.data).toBe(quoteFixture.transactionRequest.data)
  })

  test('asks for the swap to land with the agent and caps slippage', async () => {
    let url = ''
    await quoteSwap({
      sell: 'USDC',
      buy: 'ETH',
      amount: '1',
      agent: AGENT,
      slippage: 0.2,
      now: () => NOW,
      fetchFn: async (input) => {
        url = input instanceof Request ? input.url : input.toString()
        return Response.json(quoteFixture)
      },
    })
    const params = new URL(url).searchParams
    expect(params.get('toAddress')).toBe(AGENT)
    expect(params.get('slippage')).toBe('0.01')
    expect(params.get('fromAmount')).toBe('1000000')
  })

  test('refuses an unknown token, an unknown contract and heavy price impact', async () => {
    await expect(quoteSwap({ sell: 'PEPE', buy: 'ETH', amount: '1', agent: AGENT })).rejects.toMatchObject({
      code: 'unsupported',
    })
    const foreign = {
      ...quoteFixture,
      transactionRequest: { ...quoteFixture.transactionRequest, to: '0x0000000000000000000000000000000000000001' },
    }
    await expect(quote(foreign)).rejects.toMatchObject({ code: 'bad_quote' })
    const lossy = { ...quoteFixture, estimate: { ...quoteFixture.estimate, toAmountUSD: '0.5' } }
    await expect(quote(lossy)).rejects.toMatchObject({ code: 'price_impact' })
    const stranger = {
      ...quoteFixture,
      transactionRequest: { ...quoteFixture.transactionRequest, from: '0x0000000000000000000000000000000000000002' },
    }
    await expect(quote(stranger)).rejects.toBeInstanceOf(SwapError)
  })
})

describe('LI.FI calldata', () => {
  test('refuses calldata that pays someone else or calls another function', async () => {
    const elsewhere = quoteFixture.transactionRequest.data.replaceAll(AGENT_WORD, '22'.repeat(20))
    await expect(quote(withRequest({ data: elsewhere }))).rejects.toThrow(/someone other than the agent/u)
    const other = `0x4630a0d9${quoteFixture.transactionRequest.data.slice(10)}`
    await expect(quote(withRequest({ data: other }))).rejects.toThrow(/does not run/u)
  })

  test('refuses a sell amount, minimum or action that differs from the request', async () => {
    const more = { ...quoteFixture, estimate: { ...quoteFixture.estimate, fromAmount: '2000000' } }
    await expect(quote(more)).rejects.toThrow(/different amount/u)
    const greedy = { ...quoteFixture, estimate: { ...quoteFixture.estimate, toAmountMin: '490354582961072' } }
    await expect(quote(greedy)).rejects.toThrow(/less than the quoted minimum/u)
    const elsewhere = { ...quoteFixture, action: { ...quoteFixture.action, toAddress: OTHER } }
    await expect(quote(elsewhere)).rejects.toThrow(/restate/u)
    const valued = { ...quoteFixture, estimate: { ...quoteFixture.estimate, fromAmountUSD: undefined } }
    await expect(quote(valued)).rejects.toThrow(/no USD value/u)
  })

  test('re-checks the frozen calldata before signing: a tampered swap sends nothing', async () => {
    const swap = await quote()
    const tampered = {
      ...swap,
      transaction: { ...swap.transaction, data: swap.transaction.data.replaceAll(AGENT_WORD, '22'.repeat(20)) },
    }
    const h = harness({ held: 5_000_000n })
    await expect(run(tampered, h)).rejects.toMatchObject({ code: 'bad_quote' })
    expect(h.sent).toHaveLength(0)
  })
})

interface Sent {
  to: string
  data: string
  value?: bigint
  key: string
}

/** A quiet Base fee market: 300k gas at 0.01 gwei. */
const FEES: Record<string, unknown> = {
  eth_estimateGas: '0x493e0',
  eth_getBlockByNumber: { baseFeePerGas: '0x989680' },
  eth_maxPriorityFeePerGas: '0x186a0',
}

const harness = (options: { held: bigint; allowance?: bigint }) => {
  const sent: Sent[] = []
  const agent: AgentSigner = {
    address: AGENT,
    signTypedData: () => Promise.reject(new Error('unused')),
    signAuthorization: () => Promise.reject(new Error('unused')),
    sendTransaction: async ({ to, data, value, operationKey }) => {
      sent.push({ to, data, key: operationKey, ...(value === undefined ? {} : { value }) })
      return toHex(`0x${sent.length.toString(16).padStart(64, '0')}`)
    },
  }
  const rpc: JsonRpc = async (method, params) => {
    if (method === 'eth_getTransactionReceipt') return { status: '0x1' }
    if (method in FEES) return FEES[method]
    if (method === 'eth_call') {
      const data = String(field(params[0], 'data'))
      return word(data.startsWith('0xdd62ed3e') ? (options.allowance ?? 0n) : options.held)
    }
    throw new Error(`unexpected ${method}`)
  }
  return { agent, rpc, sent }
}

const run = (swap: FrozenSwap, h: ReturnType<typeof harness>, now = NOW) =>
  executeSwap({
    swap,
    agent: h.agent,
    rpc: h.rpc,
    operationKey: 'op-swap-0001',
    wait: { sleep: async () => undefined, attempts: 2 },
    now: () => now,
  })

describe('LI.FI execute', () => {
  test('approves the exact amount, then sends the quoted calldata unchanged', async () => {
    const swap = await quote()
    const h = harness({ held: 5_000_000n })
    const result = await run(swap, h)
    expect(h.sent.map((s) => s.key)).toEqual(['op-swap-0001:approve', 'op-swap-0001:swap'])
    expect(decodeFunctionData({ abi: erc20, data: toHex(h.sent[0]?.data ?? '0x') }).args).toEqual([
      LIFI_DIAMOND,
      1_000_000n,
    ])
    expect(h.sent[1]).toMatchObject({ to: LIFI_DIAMOND, data: swap.transaction.data })
    expect(result).toMatchObject({ status: 'success', explorerUrl: expect.stringContaining('basescan.org/tx/') })
  })

  test('skips the approval when the allowance already covers it', async () => {
    const h = harness({ held: 5_000_000n, allowance: 2_000_000n })
    await run(await quote(), h)
    expect(h.sent).toHaveLength(1)
  })

  test('refuses an expired quote and a wallet that holds too little, sending nothing', async () => {
    const swap = await quote()
    const h = harness({ held: 5_000_000n })
    await expect(run(swap, h, new Date('2026-10-12T06:05:00Z'))).rejects.toMatchObject({ code: 'expired' })
    const poor = harness({ held: 100n })
    await expect(run(swap, poor)).rejects.toMatchObject({ code: 'insufficient_funds' })
    expect(h.sent.length + poor.sent.length).toBe(0)
  })
})
