import { describe, expect, test } from 'vitest'
import { chainByCaip2, chainById, CHAINS } from './index.ts'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u

describe('chain table', () => {
  test('has the four mainnets and four testnets', () => {
    expect(CHAINS.filter((c) => !c.testnet).map((c) => c.id)).toEqual([8453, 1, 42161, 4217])
    expect(CHAINS.filter((c) => c.testnet).map((c) => c.id)).toEqual([84532, 11155111, 421614, 42431])
  })

  test('ids and CAIP-2 ids are unique and consistent', () => {
    expect(new Set(CHAINS.map((c) => c.id)).size).toBe(CHAINS.length)
    for (const c of CHAINS) expect(c.caip2).toBe(`eip155:${c.id}`)
  })

  test('every address is well formed', () => {
    for (const c of CHAINS) {
      const addresses = [
        c.usdc.address,
        c.delegation.manager,
        c.delegation.delegator,
        ...Object.values(c.delegation.enforcers),
      ]
      for (const address of addresses) expect(address).toMatch(ADDRESS)
    }
  })

  test('urls are https and stablecoins have six decimals', () => {
    for (const c of CHAINS) {
      expect(c.rpcUrl.startsWith('https://')).toBe(true)
      expect(c.explorerUrl.startsWith('https://')).toBe(true)
      expect(c.usdc.decimals).toBe(6)
    }
  })

  test('EIP-3009 domains exist exactly where the token supports it', () => {
    for (const c of CHAINS) {
      const tempo = c.name.startsWith('Tempo')
      expect(c.usdc.eip3009 === null).toBe(tempo)
    }
    expect(chainById(8453)?.usdc.eip3009).toEqual({ name: 'USD Coin', version: '2' })
    expect(chainById(84532)?.usdc.eip3009).toEqual({ name: 'USDC', version: '2' })
  })

  test('the delegation framework is the same v1.3.0 deployment everywhere', () => {
    const [first, ...rest] = CHAINS
    for (const c of rest) expect(c.delegation).toEqual(first?.delegation)
  })

  test('lookups', () => {
    expect(chainById(4217)?.name).toBe('Tempo')
    expect(chainByCaip2('eip155:42431')?.usdc.symbol).toBe('pathUSD')
    expect(chainById(5)).toBeUndefined()
    expect(chainByCaip2('solana:mainnet')).toBeUndefined()
  })
})
