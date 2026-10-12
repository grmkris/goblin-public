import { BASE_SEPOLIA } from '@goblin/wallet/chains'
import type { AgentSigner } from '@goblin/wallet/contract'
import { describe, expect, test } from 'vitest'
import { createRails, type RailsDeps } from './index.ts'
import { rpcFromEnv } from './rpc.ts'

const AGENT = '0x03582783c8e71b0c2D3b607E0FBdec7402f76F77'
const PAY_TO = '0xB98eF29eb2be19Ae646A8FC0248255B90A332dbC'

const signer: AgentSigner = {
  address: AGENT,
  signTypedData: () => Promise.reject(new Error('unused')),
  signAuthorization: () => Promise.reject(new Error('unused')),
  sendTransaction: () => Promise.reject(new Error('nothing may be signed here')),
}

const deps = (live: boolean): RailsDeps => ({
  live,
  signer,
  profile: async () => ({ agentAddress: AGENT, chains: [] }),
  rpcFor: () => () => Promise.reject(new Error('no chain read expected')),
  now: () => new Date('2026-10-12T06:00:00Z'),
})

const transfer = {
  chain: 'base',
  token: 'USDC',
  to: PAY_TO,
  amount: '1',
  max_usd: '2',
  operation_id: 'op-net-0001',
} as const

describe('the WALLET_LIVE switch', () => {
  test('a testnet wallet quotes the testnet token and refuses Tempo, swaps and bridges', async () => {
    const rails = createRails(deps(false))
    expect(await rails.quoteTransfer(transfer)).toMatchObject({
      token: { address: BASE_SEPOLIA.usdc.address },
      subject: 'Send 1 USDC on Base Sepolia',
    })
    await expect(rails.quoteTransfer({ ...transfer, chain: 'tempo' })).rejects.toThrow(/mainnet only/u)
    await expect(rails.swapQuote({ chain: 'base', sell: 'USDC', buy: 'ETH', amount: '1' })).rejects.toThrow(
      /mainnet only/u,
    )
    await expect(rails.bridgeQuote({ from: 'base', to: 'tempo', token: 'USDC', amount: '1' })).rejects.toThrow(
      /mainnet only/u,
    )
  })

  test('the RPC follows the network, and an override is keyed by chain id', async () => {
    const urls: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        urls.push(input instanceof Request ? input.url : input.toString())
        return Response.json({ jsonrpc: '2.0', id: 1, result: '0x1' })
      },
      { preconnect: () => undefined },
    )
    try {
      const testnet = rpcFromEnv(JSON.stringify({ 8453: 'https://mainnet.example' }), false)
      const mainnet = rpcFromEnv(JSON.stringify({ 8453: 'https://mainnet.example' }), true)
      await testnet('base')('eth_chainId', [])
      await mainnet('base')('eth_chainId', [])
      expect(urls).toEqual([BASE_SEPOLIA.rpcUrl, 'https://mainnet.example'])
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('transfers that only burn gas', () => {
  test('a zero transfer and a transfer to the agent itself are refused at the quote', async () => {
    const rails = createRails(deps(true))
    await expect(rails.quoteTransfer({ ...transfer, amount: '0' })).rejects.toThrow(/positive amount/u)
    await expect(rails.quoteTransfer({ ...transfer, to: AGENT.toLowerCase() })).rejects.toThrow(/pay itself/u)
  })
})
