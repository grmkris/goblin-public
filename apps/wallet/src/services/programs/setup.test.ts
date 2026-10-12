import type { ChainBalance } from '@goblin/wallet/contract'
import { describe, expect, test } from 'vitest'
import { fundingSentence, setupGaps, setupSentence } from './setup.ts'

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
      "add USDC to the account on Base (the upgrade's gas is paid in USDC)",
      'upgrade the account on Base',
      'sign the spending allowance',
    ])
  })

  test('funds count as soon as the owner holds USDC on Base, not ETH; a finished setup has no gaps', () => {
    expect(setupGaps({ hasAgent: true, chains: [], balances: [usdc('2.5')] })).toEqual([
      'upgrade the account on Base',
      'sign the spending allowance',
    ])
    const eth: ChainBalance = { ...usdc('0.01'), symbol: 'ETH', token: '0x0000000000000000000000000000000000000000' }
    expect(setupGaps({ hasAgent: true, chains: [], balances: [eth] })[0]).toBe(
      "add USDC to the account on Base (the upgrade's gas is paid in USDC)",
    )
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

  test('the funding sentence names the agent address on Tempo when it holds too little, and stays quiet otherwise', () => {
    const AGENT = '0x4444444444444444444444444444444444444444'
    const at = (held?: string) => ({
      address: AGENT,
      chain: 'tempo' as const,
      token: 'USDC.e' as const,
      ...(held === undefined ? {} : { held }),
    })
    expect(fundingSentence(at('0'))).toContain(`The agent wallet ${AGENT} holds 0 USDC.e on Tempo`)
    expect(fundingSentence(at('0.049999'))).toContain('add_funds')
    expect(fundingSentence(at('0.05'))).toBeUndefined()
    expect(fundingSentence(at())).toBeUndefined()
    expect(fundingSentence(undefined)).toBeUndefined()
  })
})
