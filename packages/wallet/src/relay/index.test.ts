import { keccak256 } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vitest'
import { toHex } from '../balances/hex.ts'
import type { JsonRpc } from '../balances/rpc.ts'
import { BASE, BASE_SEPOLIA } from '../chains/index.ts'
import {
  delegationOf,
  memoryRelayStore,
  RelayError,
  RelaySender,
  type RelayQuota,
  type RelayStore,
  type UpgradeRequest,
} from './index.ts'

const relayAccount = privateKeyToAccount(generatePrivateKey())
const owner = privateKeyToAccount(generatePrivateKey())

const signedUpgrade = async (
  key: string,
  overrides: { delegator?: `0x${string}`; chainId?: number; nonce?: number } = {},
) => {
  const auth = await owner.signAuthorization({
    contractAddress: overrides.delegator ?? BASE.delegation.delegator,
    chainId: overrides.chainId ?? BASE.id,
    nonce: overrides.nonce ?? 0,
  })
  const request: UpgradeRequest = {
    key,
    chain: 'base',
    owner: owner.address,
    authorization: {
      address: auth.address,
      chainId: auth.chainId,
      nonce: auth.nonce,
      r: auth.r,
      s: auth.s,
      yParity: auth.yParity ?? 0,
    },
  }
  return request
}

interface FakeNode {
  rpc: JsonRpc
  sent: string[]
  calls: string[]
  mine(): void
  baseFee: bigint
  /** The owner's account nonce. */
  ownerNonce: number
  /** What the node reports as the relay's pending nonce, before what it has seen sent. */
  relayNonce: number
}

const fakeNode = (): FakeNode => {
  const node: FakeNode = {
    sent: [],
    calls: [],
    baseFee: 100_000_000n,
    ownerNonce: 0,
    relayNonce: 7,
    rpc: async (method, params) => {
      node.calls.push(method)
      switch (method) {
        case 'eth_getTransactionCount':
          if (params[0] === owner.address) return `0x${node.ownerNonce.toString(16)}`
          return params[1] === 'pending' ? `0x${(node.relayNonce + new Set(node.sent).size).toString(16)}` : '0x7'
        case 'eth_getBlockByNumber':
          return { baseFeePerGas: `0x${node.baseFee.toString(16)}` }
        case 'eth_maxPriorityFeePerGas':
          return '0x186a0'
        case 'eth_estimateGas':
          return '0xb000'
        case 'eth_sendRawTransaction':
          node.sent.push(String(params[0]))
          return '0x'
        case 'eth_getTransactionReceipt':
          return mined.has(String(params[0])) ? { status: '0x1' } : null
        case 'eth_getCode':
          return String(params[0]) === owner.address
            ? `0xef0100${BASE.delegation.delegator.slice(2).toLowerCase()}`
            : '0x'
        default:
          throw new Error(`unexpected ${method}`)
      }
    },
    mine: () => {
      for (const raw of node.sent) mined.add(rawToHash(raw))
    },
  }
  const mined = new Set<string>()
  return node
}

const rawToHash = (raw: string) => keccak256(toHex(raw))

const sender = (
  node: FakeNode,
  attempts = 2,
  options: { live?: boolean; quota?: RelayQuota; store?: RelayStore } = {},
) =>
  new RelaySender({
    live: options.live ?? true,
    account: relayAccount,
    store: options.store ?? memoryRelayStore(),
    rpc: () => node.rpc,
    sleep: async () => undefined,
    receiptAttempts: attempts,
    ...(options.quota === undefined ? {} : { quota: options.quota }),
  })

describe('relay upgrade', () => {
  test('stores the signed transaction, broadcasts it and reports success once mined', async () => {
    const node = fakeNode()
    const relay = sender(node)
    const request = await signedUpgrade('up-1-aaaaaaaa')
    const pending = await relay.upgrade(request)
    expect(pending.status).toBe('pending')
    expect(node.sent).toHaveLength(1)
    node.mine()
    const done = await relay.upgrade(request)
    expect(done).toMatchObject({ status: 'success', txHash: pending.txHash, nonce: 7 })
    expect(node.sent).toHaveLength(1) // reconciled from the stored hash, never re-signed
  })

  test('refuses an unknown delegator, a foreign chain and a forged owner', async () => {
    const node = fakeNode()
    const relay = sender(node)
    const bad = await signedUpgrade('up-2-aaaaaaaa', { delegator: '0x0000000000000000000000000000000000000001' })
    await expect(relay.upgrade(bad)).rejects.toMatchObject({ code: 'bad_request' })
    const foreign = await signedUpgrade('up-3-aaaaaaaa', { chainId: 1 })
    await expect(relay.upgrade(foreign)).rejects.toBeInstanceOf(RelayError)
    const good = await signedUpgrade('up-4-aaaaaaaa')
    await expect(relay.upgrade({ ...good, owner: relayAccount.address })).rejects.toMatchObject({ code: 'bad_request' })
    expect(node.sent).toHaveLength(0)
  })

  test('refuses to pay above the gas ceiling', async () => {
    const node = fakeNode()
    node.baseFee = 5_000_000_000n
    const relay = sender(node)
    await expect(relay.upgrade(await signedUpgrade('up-5-aaaaaaaa'))).rejects.toMatchObject({ code: 'gas_ceiling' })
    expect(node.sent).toHaveLength(0)
  })

  test('reports a dropped transaction when its nonce was consumed elsewhere', async () => {
    const node = fakeNode()
    const relay = sender(node, 1)
    const request = await signedUpgrade('up-6-aaaaaaaa')
    await relay.upgrade(request)
    const base = node.rpc
    node.rpc = async (method, params) =>
      method === 'eth_getTransactionCount' && params[1] === 'latest' ? '0x9' : base(method, params)
    await expect(relay.upgrade(request)).rejects.toMatchObject({ code: 'dropped' })
  })

  test('keeps one upgrade in flight per chain, then signs the next on a fresh nonce', async () => {
    const node = fakeNode()
    const relay = sender(node, 1)
    const [a, b] = await Promise.allSettled([
      relay.upgrade(await signedUpgrade('up-7-aaaaaaaa')),
      relay.upgrade(await signedUpgrade('up-8-aaaaaaaa')),
    ])
    expect(a).toMatchObject({ status: 'fulfilled', value: { status: 'pending', nonce: 7 } })
    expect(b).toMatchObject({ status: 'rejected', reason: { code: 'busy' } })
    node.mine()
    expect(await relay.upgrade(await signedUpgrade('up-8-aaaaaaaa'))).toMatchObject({ nonce: 8 })
  })

  test('never reuses a nonce it signed, even when the node lags', async () => {
    const node = fakeNode()
    const store = memoryRelayStore()
    const relay = sender(node, 1, { store })
    await relay.upgrade(await signedUpgrade('up-9-aaaaaaaa'))
    node.mine()
    node.relayNonce = 0
    node.sent.length = 0
    expect(await relay.upgrade(await signedUpgrade('up-10-aaaaaaa'))).toMatchObject({ nonce: 8 })
  })

  test('refuses a universal (chain id 0) authorization and a stale owner nonce, before signing', async () => {
    const node = fakeNode()
    const relay = sender(node)
    await expect(relay.upgrade(await signedUpgrade('up-11-aaaaaaa', { chainId: 0 }))).rejects.toMatchObject({
      code: 'bad_request',
    })
    node.ownerNonce = 3
    await expect(relay.upgrade(await signedUpgrade('up-12-aaaaaaa', { nonce: 9 }))).rejects.toThrow(/nonce/u)
    expect(node.sent).toHaveLength(0)
  })

  test('caps upgrades per owner and per chain per day', async () => {
    const node = fakeNode()
    const relay = sender(node, 1, { quota: { perOwner: 1, perChain: 5 } })
    await relay.upgrade(await signedUpgrade('up-13-aaaaaaa'))
    node.mine()
    await expect(relay.upgrade(await signedUpgrade('up-14-aaaaaaa'))).rejects.toMatchObject({ code: 'quota' })
    const crowded = sender(fakeNode(), 1, { quota: { perOwner: 5, perChain: 0 } })
    await expect(crowded.upgrade(await signedUpgrade('up-15-aaaaaaa'))).rejects.toMatchObject({ code: 'quota' })
    expect(node.sent).toHaveLength(1)
  })

  test('a testnet relay takes the testnet chain id and refuses the mainnet one', async () => {
    const node = fakeNode()
    const relay = sender(node, 1, { live: false })
    await expect(relay.upgrade(await signedUpgrade('up-16-aaaaaaa'))).rejects.toMatchObject({ code: 'bad_request' })
    const testnet = await relay.upgrade(await signedUpgrade('up-17-aaaaaaa', { chainId: BASE_SEPOLIA.id }))
    expect(testnet.status).toBe('pending')
    expect(node.sent).toHaveLength(1)
  })

  test('a dropped upgrade is signed again under the same key', async () => {
    const node = fakeNode()
    const relay = sender(node, 1)
    const request = await signedUpgrade('up-18-aaaaaaa')
    const first = await relay.upgrade(request)
    const base = node.rpc
    node.rpc = async (method, params) =>
      method === 'eth_getTransactionCount' && params[1] === 'latest' ? '0x9' : base(method, params)
    await expect(relay.upgrade(request)).rejects.toMatchObject({ code: 'dropped' })
    node.rpc = base
    const again = await relay.upgrade(request)
    expect(again.txHash).not.toBe(first.txHash)
  })
})

describe('delegationOf', () => {
  test('reads the 0xef0100 designator', async () => {
    const node = fakeNode()
    expect(await delegationOf(node.rpc, owner.address)).toBe(BASE.delegation.delegator.toLowerCase())
    expect(await delegationOf(node.rpc, relayAccount.address)).toBeNull()
  })
})
