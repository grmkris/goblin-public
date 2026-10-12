import { decodeFunctionData, parseAbi } from 'viem'
import { describe, expect, test } from 'vitest'
import { toHex } from '../balances/hex.ts'
import { field, type JsonRpc } from '../balances/rpc.ts'
import type { AgentSigner } from '../contract/index.ts'
import quoteFixture from './fixtures/base-usdc-eth.json' with { type: 'json' }
import { executeSwap, LIFI_DIAMOND, quoteSwap, SwapError, type FrozenSwap } from './index.ts'

const AGENT = '0x03582783c8e71b0c2D3b607E0FBdec7402f76F77'
const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`
const NOW = new Date('2026-10-12T06:00:00Z')
const erc20 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])

const fetchQuote =
  (body: unknown = quoteFixture) =>
  async () =>
    Response.json(body)

const quote = (body?: unknown) =>
  quoteSwap({ sell: 'USDC', buy: 'ETH', amount: '1', agent: AGENT, fetchFn: fetchQuote(body), now: () => NOW })

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
