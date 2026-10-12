import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, parseAbi } from 'viem'
import { describe, expect, test } from 'vitest'
import { BASE, TEMPO } from '../chains/index.ts'
import { getAllowanceState, getBalances, parsePeriodTerms } from './index.ts'
import { toHex } from './hex.ts'
import { field, httpJsonRpc, quantity, type JsonRpc } from './rpc.ts'

const AGENT = '0x03582783c8e71b0c2D3b607E0FBdec7402f76F77'
const OWNER = '0x7Ff152896986BDC96a37e8a8eCeF454733318b33'
const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`

const callOf = (value: unknown) => ({ to: String(field(value, 'to')), data: toHex(String(field(value, 'data'))) })

const balanceOfAbi = parseAbi(['function balanceOf(address owner) view returns (uint256)'])

describe('balances', () => {
  test('reads native and USDC for owner and agent, none native on Tempo, and survives a failing chain', async () => {
    const rpcFor =
      (chain: string): JsonRpc =>
      async (method, params) => {
        if (chain === 'ethereum') throw new Error('rate limited')
        if (method === 'eth_getBalance') return word(2n * 10n ** 15n)
        const call = callOf(params[0])
        expect(decodeFunctionData({ abi: balanceOfAbi, data: call.data }).functionName).toBe('balanceOf')
        const usdc = chain === 'tempo' ? TEMPO.usdc.address : BASE.usdc.address
        expect(call.to).toBe(usdc)
        return word(1_500_000n)
      }
    const result = await getBalances({ agent: AGENT, owner: OWNER, chains: ['base', 'tempo', 'ethereum'], rpcFor })
    const [base, tempo, ethereum] = result
    expect(base?.agent.native?.formatted).toBe('0.002')
    expect(base?.owner?.usdc.formatted).toBe('1.5')
    expect(tempo?.agent.native).toBeUndefined()
    expect(tempo?.agent.usdc).toMatchObject({ symbol: 'USDC.e', formatted: '1.5' })
    expect(ethereum?.error).toBe('rate limited')
  })
})

describe('allowance state', () => {
  const terms = `0x${BASE.usdc.address.slice(2)}${'0'.repeat(58)}4c4b40${'0'.repeat(61)}e10${'0'.repeat(56)}67000000`
  test('parses the 116-byte terms', () => {
    const parsed = parsePeriodTerms(terms)
    expect(parsed.periodAmount).toBe(5_000_000n)
    expect(parsed.periodDuration).toBe(0xe10n)
    expect(parsed.startDate).toBe(0x67000000n)
    expect(() => parsePeriodTerms('0x1234')).toThrow()
  })

  test('calls getAvailableAmount on the enforcer with the delegation hash and manager', async () => {
    const calls: { to: string; data: string }[] = []
    const rpcFor = (): JsonRpc => async (_method, params) => {
      calls.push(callOf(params[0]))
      return encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }], [3_000_000n, false, 4n])
    }
    const hash = `0x${'ab'.repeat(32)}`
    const state = await getAllowanceState({ chain: 'base', delegationHash: hash, terms, rpcFor })
    expect(state).toMatchObject({
      available: 3_000_000n,
      periodAmount: 5_000_000n,
      isNewPeriod: false,
      currentPeriod: 4n,
    })
    expect(state.periodEndsAt).toBe(0x67000000n + 4n * 0xe10n)
    expect(calls[0]?.to).toBe(BASE.delegation.enforcers.erc20PeriodTransfer)
    const expected = encodeFunctionData({
      abi: parseAbi([
        'function getAvailableAmount(bytes32 delegationHash, address delegationManager, bytes terms) view returns (uint256, bool, uint256)',
      ]),
      functionName: 'getAvailableAmount',
      args: [toHex(hash), BASE.delegation.manager, toHex(terms)],
    })
    expect(calls[0]?.data.toLowerCase()).toBe(expected.toLowerCase())
  })
})

describe('json-rpc', () => {
  test('wraps results and errors', async () => {
    const ok = httpJsonRpc('http://node', async () => Response.json({ jsonrpc: '2.0', id: 1, result: '0x10' }))
    expect(quantity(await ok('eth_blockNumber', []))).toBe(16n)
    const bad = httpJsonRpc('http://node', async () =>
      Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'nope' } }),
    )
    await expect(bad('eth_call', [])).rejects.toMatchObject({ code: -32000 })
    expect(() => quantity('abc')).toThrow()
  })
})
