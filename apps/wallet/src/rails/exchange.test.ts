import type { AgentSigner, Operation, Terms } from '@goblin/wallet/contract'
import { describe, expect, test } from 'vitest'
import { createRails, type RailsDeps } from './index.ts'

const AGENT = '0x03582783c8e71b0c2D3b607E0FBdec7402f76F77'
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const NOW = new Date('2026-10-12T06:00:00Z')

const sent: string[] = []
const signer: AgentSigner = {
  address: AGENT,
  signTypedData: () => Promise.reject(new Error('unused')),
  signAuthorization: () => Promise.reject(new Error('unused')),
  signUserOperation: async ({ userOp }) => {
    sent.push(userOp.sender)
    return `0x${'00'.repeat(65)}`
  },
}

const deps = (live = true): RailsDeps => ({
  live,
  signer,
  profile: async () => ({ agentAddress: AGENT, chains: [] }),
  rpcFor: () => () => Promise.reject(new Error('no chain read expected')),
  now: () => NOW,
})

const terms: Terms = {
  kind: 'swap',
  chain: 'base',
  rail: 'lifi',
  subject: 'Swap USDC to ETH',
  token: { symbol: 'USDC', address: BASE_USDC, decimals: 6 },
  amount: '1',
  amountUsd: '1',
  recipient: AGENT,
  expiresAt: '2026-10-12T06:01:30.000Z',
}

const operation: Operation = {
  id: 'op-exchange-01',
  status: 'reserved',
  terms,
  termsHash: `0x${'00'.repeat(32)}`,
  limitsVersion: 1,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
}

const swapPayload = (sellAmount: string) => ({
  chain: 'base',
  sell: { symbol: 'USDC', address: BASE_USDC, decimals: 6 },
  buy: { symbol: 'ETH', address: '0x0000000000000000000000000000000000000000', decimals: 18 },
  sellAmount,
  buyAmount: '1',
  buyAmountMin: '1',
  transaction: { to: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE', data: '0x', value: '0x0', chainId: 8453 },
  approvalAddress: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
  sellUsd: '1',
  buyUsd: '1',
  feesUsd: '0',
  tool: 'lifi',
  agent: AGENT,
  quotedAt: NOW.toISOString(),
  expiresAt: terms.expiresAt,
})

describe('executing a stored quote', () => {
  test('a quote that sells more than the approved terms fails before anything is signed', async () => {
    const outcome = await createRails(deps()).swapExecute(operation, swapPayload('2000000'))
    expect(outcome).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('does not match') })
    expect(sent).toEqual([])
  })

  test('an unreadable quote, undecodable calldata or a testnet wallet fails rather than turning uncertain', async () => {
    const rails = createRails(deps())
    expect((await rails.swapExecute(operation, { nope: true })).outcome).toBe('failed')
    const opaque = await rails.swapExecute(operation, swapPayload('1000000'))
    expect(opaque).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('does not run') })
    const testnet = await createRails(deps(false)).swapExecute(operation, swapPayload('1000000'))
    expect(testnet).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('mainnet only') })
    expect(sent).toEqual([])
  })
})
