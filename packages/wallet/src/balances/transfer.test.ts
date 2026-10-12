import { decodeFunctionData, parseAbi } from 'viem'
import { describe, expect, test } from 'vitest'
import { BASE, BASE_SEPOLIA } from '../chains/index.ts'
import type { AgentSigner, TransactionFees } from '../contract/index.ts'
import { toHex } from './hex.ts'
import { field, httpJsonRpc, JsonRpcError, type JsonRpc } from './rpc.ts'
import { transferUsdc, TransferError, type TopUp } from './transfer.ts'

const AGENT = '0x03582783c8e71b0c2D3b607E0FBdec7402f76F77'
const RECIPIENT = '0xB98eF29eb2be19Ae646A8FC0248255B90A332dbC'
const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`
const erc20 = parseAbi(['function transfer(address to, uint256 amount) returns (bool)'])

interface Sent {
  to: string
  data: string
  key: string
  fees?: TransactionFees | undefined
}

const down: JsonRpc = () => Promise.reject(new JsonRpcError('eth_getBalance', 'HTTP 429'))

const harness = (options: {
  held: bigint
  gas?: bigint
  revertWith?: string
  mined?: boolean
  baseFee?: bigint
  /** How many balance reads after the top-up still show the old balance (a lagging RPC node). */
  staleReads?: number
}) => {
  const sent: Sent[] = []
  let stale = options.staleReads ?? 0
  const agent: AgentSigner = {
    address: AGENT,
    signTypedData: () => Promise.reject(new Error('unused')),
    signAuthorization: () => Promise.reject(new Error('unused')),
    sendTransaction: async ({ to, data, fees, operationKey }) => {
      sent.push({ to, data, key: operationKey, fees })
      return toHex(`0x${sent.length.toString(16).padStart(64, '0')}`)
    },
  }
  const rpc: JsonRpc = async (method, params) => {
    switch (method) {
      case 'eth_getBalance':
        return word(options.gas ?? 1_000_000_000_000_000n)
      case 'eth_call': {
        const to = String(field(params[0], 'to'))
        if (options.revertWith !== undefined && to === BASE.delegation.manager) throw new Error(options.revertWith)
        // After the top-up is sent the agent holds what it asked for, once the node has caught up.
        if (sent.some((s) => s.to === BASE.delegation.manager) && (stale -= 1) < 0) return word(10n ** 12n)
        return word(options.held)
      }
      case 'eth_getTransactionReceipt':
        return options.mined === false ? null : { status: '0x1' }
      case 'eth_estimateGas':
        return '0x186a0'
      case 'eth_getBlockByNumber':
        return { baseFeePerGas: `0x${(options.baseFee ?? 10_000_000n).toString(16)}` }
      case 'eth_maxPriorityFeePerGas':
        return '0xf4240'
      default:
        throw new Error(`unexpected ${method}`)
    }
  }
  return { agent, rpc, sent }
}

const topUp = (available: bigint): TopUp & { asked: bigint[] } => {
  const asked: bigint[] = []
  return {
    asked,
    available: async () => available,
    redeemCalldata: (amount) => {
      asked.push(amount)
      return '0xdeadbeef'
    },
  }
}

const base = {
  live: true,
  chain: 'base',
  to: RECIPIENT,
  operationKey: 'op-tr-evm-1',
  wait: { sleep: async () => undefined, attempts: 2 },
} as const

describe('EVM transfer', () => {
  test('pays directly when the agent holds enough', async () => {
    const h = harness({ held: 5_000_000n })
    const result = await transferUsdc({ ...base, amount: 2_000_000n, agent: h.agent, rpc: h.rpc })
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.to).toBe(BASE.usdc.address)
    expect(decodeFunctionData({ abi: erc20, data: toHex(h.sent[0]?.data ?? '0x') }).args).toEqual([
      RECIPIENT,
      2_000_000n,
    ])
    expect(result).toMatchObject({
      status: 'success',
      explorerUrl: expect.stringContaining('https://basescan.org/tx/0x'),
    })
    expect(result.topUpTxHash).toBeUndefined()
  })

  test('redeems exactly the shortfall from the owner allowance, then pays', async () => {
    const h = harness({ held: 500_000n })
    const top = topUp(10_000_000n)
    const result = await transferUsdc({ ...base, amount: 2_000_000n, agent: h.agent, rpc: h.rpc, topUp: top })
    expect(top.asked).toEqual([1_500_000n])
    expect(h.sent.map((s) => s.to)).toEqual([BASE.delegation.manager, BASE.usdc.address])
    expect(h.sent.map((s) => s.key)).toEqual(['op-tr-evm-1:topup', 'op-tr-evm-1:pay'])
    expect(result.topUpAmount).toBe(1_500_000n)
  })

  test('after a top-up, waits for a lagging node to show the new balance, or fails before paying', async () => {
    const slept: number[] = []
    const wait = { attempts: 4, sleep: async (ms: number) => void slept.push(ms) }
    const lagging = harness({ held: 0n, staleReads: 2 })
    const paid = await transferUsdc({
      ...base,
      amount: 1_000_000n,
      agent: lagging.agent,
      rpc: lagging.rpc,
      topUp: topUp(10_000_000n),
      wait,
    })
    expect(lagging.sent.map((s) => s.key)).toEqual(['op-tr-evm-1:topup', 'op-tr-evm-1:pay'])
    expect(paid.status).toBe('success')
    expect(slept.length).toBeGreaterThan(0)
    const stuck = harness({ held: 0n, staleReads: 99 })
    await expect(
      transferUsdc({
        ...base,
        amount: 1_000_000n,
        agent: stuck.agent,
        rpc: stuck.rpc,
        topUp: topUp(10_000_000n),
        wait,
      }),
    ).rejects.toMatchObject({ code: 'rpc_unavailable', uncertain: false })
    expect(stuck.sent.map((s) => s.key)).toEqual(['op-tr-evm-1:topup'])
  })

  test('refuses before sending when there is no allowance to cover the shortfall', async () => {
    const h = harness({ held: 0n })
    await expect(
      transferUsdc({ ...base, amount: 2_000_000n, agent: h.agent, rpc: h.rpc, topUp: topUp(1_000_000n) }),
    ).rejects.toMatchObject({ code: 'allowance_exhausted' })
    await expect(transferUsdc({ ...base, amount: 2_000_000n, agent: h.agent, rpc: h.rpc })).rejects.toMatchObject({
      code: 'insufficient_funds',
    })
    expect(h.sent).toHaveLength(0)
  })

  test('maps the enforcer revert to an allowance error before broadcasting', async () => {
    const h = harness({
      held: 0n,
      revertWith: 'execution reverted: ERC20PeriodTransferEnforcer:transfer-amount-exceeded',
    })
    const failure = transferUsdc({ ...base, amount: 2_000_000n, agent: h.agent, rpc: h.rpc, topUp: topUp(9_000_000n) })
    await expect(failure).rejects.toBeInstanceOf(TransferError)
    await expect(failure).rejects.toMatchObject({ code: 'allowance_exhausted', uncertain: false })
    expect(h.sent).toHaveLength(0)
  })

  test('a node that does not answer before signing fails the transfer, and nothing is sent', async () => {
    const h = harness({ held: 5_000_000n })
    await expect(transferUsdc({ ...base, amount: 1n, agent: h.agent, rpc: down })).rejects.toMatchObject({
      code: 'rpc_unavailable',
      uncertain: false,
    })
    expect(h.sent).toHaveLength(0)
  })

  test('a busy node (429) is asked again before giving up', async () => {
    const statuses = [429, 429, 200]
    const fetchFn = Object.assign(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }), { status: statuses.shift() ?? 200 }),
        ),
      { preconnect: () => undefined },
    )
    await expect(httpJsonRpc('https://node.test', fetchFn, [0, 0])('eth_chainId', [])).resolves.toBe('0x1')
  })

  test('needs gas, and reports a missing receipt as pending', async () => {
    const dry = harness({ held: 5_000_000n, gas: 0n })
    await expect(transferUsdc({ ...base, amount: 1n, agent: dry.agent, rpc: dry.rpc })).rejects.toMatchObject({
      code: 'no_gas',
    })
    const slow = harness({ held: 5_000_000n, mined: false })
    expect((await transferUsdc({ ...base, amount: 1n, agent: slow.agent, rpc: slow.rpc })).status).toBe('pending')
  })

  test('a signer failure is uncertain', async () => {
    const h = harness({ held: 5_000_000n })
    const agent: AgentSigner = { ...h.agent, sendTransaction: () => Promise.reject(new Error('timeout')) }
    await expect(transferUsdc({ ...base, amount: 1n, agent, rpc: h.rpc })).rejects.toMatchObject({
      code: 'uncertain',
      uncertain: true,
    })
    expect(toHex('0x')).toBe('0x')
  })

  test('refuses a zero transfer and a transfer to the agent itself, before anything is signed', async () => {
    const h = harness({ held: 5_000_000n })
    await expect(transferUsdc({ ...base, amount: 0n, agent: h.agent, rpc: h.rpc })).rejects.toMatchObject({
      code: 'invalid_amount',
    })
    await expect(
      transferUsdc({ ...base, to: AGENT.toLowerCase(), amount: 1n, agent: h.agent, rpc: h.rpc }),
    ).rejects.toMatchObject({ code: 'invalid_amount' })
    expect(h.sent).toHaveLength(0)
  })

  test('refuses a transaction whose fee is above the chain ceiling, before signing', async () => {
    // 100k gas × 1.3 × (2 × 1000 gwei + tip) is far above Base's ceiling.
    const h = harness({ held: 5_000_000n, baseFee: 1_000_000_000_000n })
    await expect(transferUsdc({ ...base, amount: 1n, agent: h.agent, rpc: h.rpc })).rejects.toMatchObject({
      code: 'fee_ceiling',
      uncertain: false,
    })
    expect(h.sent).toHaveLength(0)
  })

  test('signs with the fee bounds the ceiling allowed: padded gas, twice the base fee plus the tip', async () => {
    const h = harness({ held: 5_000_000n })
    await transferUsdc({ ...base, amount: 1n, agent: h.agent, rpc: h.rpc })
    // 100k gas × 1.3, 2 × 0.01 gwei + 0.001 gwei.
    expect(h.sent[0]?.fees).toEqual({ gasLimit: 130_000n, maxFeePerGas: 21_000_000n, maxPriorityFeePerGas: 1_000_000n })
  })

  test('pays the testnet token on the testnet when the wallet is not live', async () => {
    const h = harness({ held: 5_000_000n })
    const result = await transferUsdc({ ...base, live: false, amount: 1n, agent: h.agent, rpc: h.rpc })
    expect(h.sent[0]?.to).toBe(BASE_SEPOLIA.usdc.address)
    expect(result.explorerUrl).toContain('sepolia.basescan.org/tx/')
  })
})
