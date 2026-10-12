import { decodeFunctionData, parseAbi } from 'viem'
import { describe, expect, test } from 'vitest'
import { fakeBundler, fakeNode, localAgent, TEST_FEE_BOUND, TEST_TX, TEST_USEROP_HASH } from '../bundler/testing.ts'
import { BASE } from '../chains/index.ts'
import type { AgentSigner } from '../contract/index.ts'
import { toHex } from './hex.ts'
import { JsonRpcError, type JsonRpc } from './rpc.ts'
import { ensureUsdc, transferUsdc, type TopUp } from './transfer.ts'

const RECIPIENT = '0xB98eF29eb2be19Ae646A8FC0248255B90A332dbC'
const erc20 = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
])
const agent = localAgent()
const instant = { sleep: async () => undefined, attempts: 2 }
const down: JsonRpc = () => Promise.reject(new JsonRpcError('eth_call', 'HTTP 429'))

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

const route = (usdc: bigint, options: { delegated?: boolean; bundler?: ReturnType<typeof fakeBundler> } = {}) => {
  const bundler = options.bundler ?? fakeBundler()
  const rpc = fakeNode({
    usdc: () => usdc,
    ...(options.delegated === undefined ? {} : { delegated: options.delegated }),
  })
  return {
    bundler,
    input: {
      live: true,
      chain: 'base',
      to: RECIPIENT,
      operationKey: 'op-tr-evm-1',
      agent,
      rpc,
      bundler: bundler.rpc,
      wait: instant,
    } as const,
  }
}

const decoded = (call: { callData: string }) => decodeFunctionData({ abi: erc20, data: toHex(call.callData) })

describe('an EVM transfer is one UserOperation from the agent, its gas paid in USDC', () => {
  test('pays directly when the agent holds the amount plus the gas: the transfer, then the paymaster approval', async () => {
    const { bundler, input } = route(5_000_000n)
    const result = await transferUsdc({ ...input, amount: 2_000_000n })
    expect(result).toEqual({
      userOpHash: TEST_USEROP_HASH,
      txHash: TEST_TX,
      status: 'success',
      explorerUrl: `${BASE.explorerUrl}/tx/${TEST_TX}`,
    })
    const [batch] = bundler.batches
    expect(batch?.map((call) => decoded(call).functionName)).toEqual(['transfer', 'approve'])
    expect(decoded(batch?.[0] ?? { callData: '0x' }).args).toEqual([RECIPIENT, 2_000_000n])
    expect(decoded(batch?.[1] ?? { callData: '0x' }).args[1]).toBe(TEST_FEE_BOUND)
  })

  test("tops up exactly the shortfall plus the gas from the owner's allowance, in the same operation", async () => {
    const { bundler, input } = route(500_000n)
    const top = topUp(20_000_000n)
    const result = await transferUsdc({ ...input, amount: 2_000_000n, topUp: top })
    expect(top.asked.at(-1)).toBe(2_000_000n - 500_000n + TEST_FEE_BOUND)
    expect(result.topUpAmount).toBe(2_000_000n - 500_000n + TEST_FEE_BOUND)
    const [batch] = bundler.batches
    expect(batch?.[0]).toEqual({ target: BASE.delegation.manager, value: 0n, callData: '0xdeadbeef' })
    expect(batch?.length).toBe(3)
  })

  test('refuses before signing when the allowance cannot cover it, or there is no allowance', async () => {
    const short = route(500_000n)
    await expect(transferUsdc({ ...short.input, amount: 2_000_000n, topUp: topUp(1_000_000n) })).rejects.toMatchObject({
      code: 'allowance_exhausted',
    })
    expect(short.bundler.methods).not.toContain('eth_sendUserOperation')
    await expect(transferUsdc({ ...route(500_000n).input, amount: 2_000_000n })).rejects.toMatchObject({
      code: 'insufficient_funds',
    })
  })

  test("the chain's own refusal, in the wallet's words, before anything is signed", async () => {
    const bundler = fakeBundler({
      refuse: {
        method: 'eth_estimateUserOperationGas',
        message: 'reverted: ERC20PeriodTransferEnforcer:transfer-amount-exceeded',
      },
    })
    const { input } = route(500_000n, { bundler })
    await expect(transferUsdc({ ...input, amount: 2_000_000n, topUp: topUp(9_000_000n) })).rejects.toMatchObject({
      code: 'allowance_exhausted',
    })
  })

  test("the agent's first operation carries its 7702 authorization; once delegated, none", async () => {
    const fresh = route(5_000_000n, { delegated: false })
    await transferUsdc({ ...fresh.input, amount: 1n })
    expect(fresh.bundler.authorizations).toEqual([
      expect.objectContaining({ address: BASE.delegation.delegator, chainId: '0x2105', nonce: '0x5' }),
    ])
    const upgraded = route(5_000_000n)
    await transferUsdc({ ...upgraded.input, amount: 1n })
    expect(upgraded.bundler.authorizations).toEqual([])
  })

  test('a batch not mined in time is pending with no transaction yet; a mined revert is reverted', async () => {
    const slow = route(5_000_000n, { bundler: fakeBundler({ receipt: 'none' }) })
    expect(await transferUsdc({ ...slow.input, amount: 1n })).toEqual({
      userOpHash: TEST_USEROP_HASH,
      status: 'pending',
    })
    const reverted = route(5_000_000n, { bundler: fakeBundler({ receipt: 'reverted' }) })
    expect((await transferUsdc({ ...reverted.input, amount: 1n })).status).toBe('reverted')
  })

  test('refuses a zero transfer, paying itself, a testnet, a dead node and a signer that will not sign', async () => {
    const { input } = route(5_000_000n)
    await expect(transferUsdc({ ...input, amount: 0n })).rejects.toMatchObject({ code: 'invalid_amount' })
    await expect(transferUsdc({ ...input, to: agent.address.toLowerCase(), amount: 1n })).rejects.toMatchObject({
      code: 'invalid_amount',
    })
    await expect(transferUsdc({ ...input, live: false, amount: 1n })).rejects.toMatchObject({ code: 'unsupported' })
    await expect(transferUsdc({ ...input, rpc: down, amount: 1n })).rejects.toMatchObject({ code: 'rpc_unavailable' })
    const refusing: AgentSigner = { ...agent, signUserOperation: () => Promise.reject(new Error('policy')) }
    const watched = route(5_000_000n)
    await expect(transferUsdc({ ...watched.input, agent: refusing, amount: 1n })).rejects.toMatchObject({
      code: 'signer_refused',
    })
    expect(watched.bundler.methods).not.toContain('eth_sendUserOperation')
  })
})

describe('funding an off-chain payment (x402)', () => {
  test('does nothing when the agent holds enough; otherwise one top-up operation, then waits for the balance', async () => {
    const enough = route(5_000_000n)
    expect(await ensureUsdc({ ...enough.input, amount: 1_000_000n })).toEqual({})
    expect(enough.bundler.methods).toEqual([])
    let held = 100_000n
    const bundler = fakeBundler()
    const top = topUp(9_000_000n)
    const rpc = fakeNode({ usdc: () => (bundler.batches.length > 0 ? (held = 2_000_000n) : held) })
    const funded = await ensureUsdc({ ...enough.input, rpc, bundler: bundler.rpc, topUp: top, amount: 1_000_000n })
    expect(funded).toEqual({ topUpTxHash: TEST_TX, topUpAmount: 1_000_000n - 100_000n + TEST_FEE_BOUND })
    expect(bundler.batches[0]?.length).toBe(2)
  })
})
