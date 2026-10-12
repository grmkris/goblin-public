import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vitest'
import { BASE } from '../chains/index.ts'
import { authorizationSignedBy, delegationOf, pendingNonce } from './delegation.ts'
import type { JsonRpc } from './rpc.ts'

const owner = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const DELEGATOR = BASE.delegation.delegator

/** A node where `owner` delegates to the DeleGator and every other address is a plain account at nonce 7. */
const node: JsonRpc = async (method, params) => {
  if (method === 'eth_getCode')
    return params[0] === owner.address ? `0xef0100${DELEGATOR.slice(2).toLowerCase()}` : '0x'
  if (method === 'eth_getTransactionCount') return params[1] === 'pending' ? '0x7' : '0x6'
  throw new Error(`unexpected ${method}`)
}

describe('EIP-7702 reads', () => {
  test("an account's delegation is read from its code; a plain account has none", async () => {
    expect(await delegationOf(node, owner.address)).toBe(DELEGATOR.toLowerCase())
    expect(await delegationOf(node, '0x3333333333333333333333333333333333333333')).toBeNull()
  })

  test('an authorization recovers to its signer, and the nonce it must name counts pending transactions', async () => {
    if (owner.signAuthorization === undefined) throw new Error('a viem local account signs authorizations')
    const signed = await owner.signAuthorization({ contractAddress: DELEGATOR, chainId: BASE.id, nonce: 7 })
    const auth = {
      address: DELEGATOR,
      chainId: BASE.id,
      nonce: 7,
      r: signed.r,
      s: signed.s,
      yParity: signed.yParity ?? 0,
    }
    expect(await authorizationSignedBy(auth)).toBe(owner.address)
    expect(await authorizationSignedBy({ ...auth, nonce: 8 })).not.toBe(owner.address)
    expect(await pendingNonce(node, owner.address)).toBe(7n)
  })
})
