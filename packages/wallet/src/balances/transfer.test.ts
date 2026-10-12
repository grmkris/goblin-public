import { decodeFunctionData, parseAbi } from 'viem'
import { describe, expect, test } from 'vitest'
import { BASE } from '../chains/index.ts'
import type { AgentSigner } from '../contract/index.ts'
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
}

const down: JsonRpc = () => Promise.reject(new JsonRpcError('eth_getBalance', 'HTTP 429'))

const harness = (options: { held: bigint; gas?: bigint; revertWith?: string; mined?: boolean }) => {
  const sent: Sent[] = []
  const agent: AgentSigner = {
    address: AGENT,
    signTypedData: () => Promise.reject(new Error('unused')),
    signAuthorization: () => Promise.reject(new Error('unused')),
    sendTransaction: async ({ to, data, operationKey }) => {
      sent.push({ to, data, key: operationKey })
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
        return word(options.held)
      }
      case 'eth_getTransactionReceipt':
        return options.mined === false ? null : { status: '0x1' }
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
})
