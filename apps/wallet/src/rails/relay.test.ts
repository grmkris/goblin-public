import { DatabaseSync } from 'node:sqlite'
import type { JsonRpc } from '@goblin/wallet/balances'
import { BASE } from '@goblin/wallet/chains'
import { relayAccountFromKey, type UpgradeRequest } from '@goblin/wallet/relay'
import { describe, expect, test } from 'vitest'
import { RelayObject, relayClient } from './relay.ts'

const ownerAccount = relayAccountFromKey(`0x${'11'.repeat(32)}`)
const RELAY_KEY = `0x${'22'.repeat(32)}`
const DESIGNATOR = `0xef0100${BASE.delegation.delegator.slice(2).toLowerCase()}`

const sqlHost = () => {
  const db = new DatabaseSync(':memory:')
  return {
    storage: {
      sql: { exec: (query: string, ...bindings: unknown[]) => ({ toArray: () => db.prepare(query).all(...bindings) }) },
      transactionSync: <T>(write: () => T): T => write(),
    },
  }
}

/**
 * A Base node: the owner's nonce is 0, the relay's starts at 5, nothing mines until `mine()`. Once a sent upgrade has
 * mined, the owner's code is the DeleGator designator, unless the chain skipped the authorization (`applied: false`).
 */
const fakeNode = () => {
  const sent: string[] = []
  const state = { mined: false, applied: true }
  const rpc: JsonRpc = async (method, params) => {
    switch (method) {
      case 'eth_getTransactionCount':
        if (params[0] === ownerAccount.address) return '0x0'
        return params[1] === 'pending' ? `0x${(5 + new Set(sent).size).toString(16)}` : '0x5'
      case 'eth_getBlockByNumber':
        return { baseFeePerGas: '0x989680' }
      case 'eth_maxPriorityFeePerGas':
        return '0x186a0'
      case 'eth_estimateGas':
        return '0xb000'
      case 'eth_sendRawTransaction':
        sent.push(String(params[0]))
        return '0x'
      case 'eth_getTransactionReceipt':
        return state.mined && sent.length > 0 ? { status: '0x1' } : null
      case 'eth_getCode':
        return state.mined && state.applied && sent.length > 0 ? DESIGNATOR : '0x'
      default:
        throw new Error(`unexpected ${method}`)
    }
  }
  const mine = () => {
    state.mined = true
  }
  return { rpc, sent, state, mine }
}

const relayEnv = { RELAY_PRIVATE_KEY: RELAY_KEY, RPC_URLS: '', WALLET_LIVE: '1' }

const signed = async (nonce = 0): Promise<UpgradeRequest['authorization']> => {
  if (ownerAccount.signAuthorization === undefined) throw new Error('a viem local account signs authorizations')
  const auth = await ownerAccount.signAuthorization({
    contractAddress: BASE.delegation.delegator,
    chainId: BASE.id,
    nonce,
  })
  return { address: auth.address, chainId: auth.chainId, nonce, r: auth.r, s: auth.s, yParity: auth.yParity ?? 0 }
}

const objectOn = (host: ReturnType<typeof sqlHost>, rpc: JsonRpc) =>
  new RelayObject(host, relayEnv, { rpcFor: () => rpc, sleep: async () => undefined, receiptAttempts: 1 })

describe('the WalletRelay Durable Object', () => {
  test('a restarted object rebroadcasts the stored bytes and never signs a second transaction', async () => {
    const node = fakeNode()
    const host = sqlHost()
    const request = { key: 'upgrade:base:owner:0', chain: 'base' as const, owner: ownerAccount.address }
    const first = await relayClient(() => objectOn(host, node.rpc)).upgrade({
      ...request,
      authorization: await signed(),
    })
    expect(first).toMatchObject({ status: 'pending', nonce: 5 })
    const again = await relayClient(() => objectOn(host, node.rpc)).upgrade({
      ...request,
      authorization: await signed(),
    })
    expect(again).toEqual(first)
    expect(node.sent).toHaveLength(2)
    expect(new Set(node.sent).size).toBe(1)
  })

  test('the stored in-flight transaction makes a second owner wait, whichever object instance asks', async () => {
    const node = fakeNode()
    const host = sqlHost()
    const owner = ownerAccount.address
    await relayClient(() => objectOn(host, node.rpc)).upgrade({
      key: 'k-1',
      chain: 'base',
      owner,
      authorization: await signed(),
    })
    const busy = relayClient(() => objectOn(host, node.rpc)).upgrade({
      key: 'k-2',
      chain: 'base',
      owner,
      authorization: await signed(),
    })
    await expect(busy).rejects.toMatchObject({ _tag: 'RelayError', code: 'busy' })
  })
})
