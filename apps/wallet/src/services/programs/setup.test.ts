import type { ChainBalance } from '@goblin/wallet/contract'
import { describe, expect, test } from 'vitest'
import { setupGaps, setupSentence } from './setup.ts'

const OWNER = '0x1111111111111111111111111111111111111111'
const usdc = (balance: string): ChainBalance => ({
  chain: 'base',
  symbol: 'USDC',
  token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  decimals: 6,
  balance,
  holder: 'owner',
  address: OWNER,
})

describe('setup gaps', () => {
  test('a fresh owner has every step left, in order', () => {
    expect(setupGaps({ hasAgent: false, chains: [], balances: [] })).toEqual([
      'create the agent wallet',
      'add funds to the account (USDC or ETH, on any EVM chain)',
      'upgrade the account on Base',
      'sign the spending allowance',
    ])
  })

  test('funds count as soon as the owner holds USDC on Base; a finished setup has no gaps', () => {
    expect(setupGaps({ hasAgent: true, chains: [], balances: [usdc('2.5')] })).toEqual([
      'upgrade the account on Base',
      'sign the spending allowance',
    ])
    const done = [
      {
        chain: 'base' as const,
        upgraded: true,
        allowance: { perHour: '20', expiresAt: '2026-10-19T00:00:00Z', delegationHash: '0xab' },
      },
    ]
    expect(setupGaps({ hasAgent: true, chains: done, balances: [usdc('0')] })).toEqual([])
  })

  test('the sentence names what is missing and where the owner finishes it', () => {
    expect(setupSentence([], 'https://wallet.test')).toBeUndefined()
    expect(setupSentence(['upgrade the account on Base', 'sign the spending allowance'], 'https://wallet.test')).toBe(
      "Setup isn't finished; ask the owner to upgrade the account on Base, then sign the spending allowance at https://wallet.test/. Paid tools stay blocked until then.",
    )
  })
})
