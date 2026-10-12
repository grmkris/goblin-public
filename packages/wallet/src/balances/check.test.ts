import { describe, expect, test } from 'vitest'
import { authorizationUsed, transactionFate } from './check.ts'
import type { JsonRpc } from './rpc.ts'

const HASH = `0x${'ab'.repeat(32)}`
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const FROM = '0x03582783c8e71b0c2D3b607E0FBdec7402f76F77'
const NONCE = `0x${'cd'.repeat(32)}`

describe('transactionFate', () => {
  test.each([
    [{ status: '0x1' }, 'success'],
    [{ status: '0x0' }, 'reverted'],
    [null, 'not_found'],
  ] as const)('a receipt of %j is %s', async (receipt, fate) => {
    const rpc: JsonRpc = async (method, params) => {
      expect([method, params]).toEqual(['eth_getTransactionReceipt', [HASH]])
      return receipt
    }
    expect(await transactionFate(rpc, HASH)).toBe(fate)
  })
})

describe('authorizationUsed', () => {
  test.each([
    [`0x${'0'.repeat(63)}1`, true],
    [`0x${'0'.repeat(64)}`, false],
  ])('authorizationState answering %s is %s', async (word, used) => {
    const calls: { readonly method: string; readonly params: readonly unknown[] }[] = []
    const rpc: JsonRpc = async (method, params) => {
      calls.push({ method, params })
      return word
    }
    expect(await authorizationUsed(rpc, USDC, { from: FROM, nonce: NONCE })).toBe(used)
    // authorizationState(address,bytes32), then the padded signer and the nonce.
    expect(calls).toEqual([
      {
        method: 'eth_call',
        params: [
          { to: USDC, data: expect.stringMatching(new RegExp(`^0xe94a0102[0-9a-f]{64}${'cd'.repeat(32)}$`, 'u')) },
          'latest',
        ],
      },
    ])
  })
})
