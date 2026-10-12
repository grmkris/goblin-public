import type { ChainBalance, ChainSetup, LimitView } from '@goblin/wallet/contract'
import { describe, expect, test } from 'vitest'
import { type FloatSource, floatSource, fundingSentence, setupGaps, setupSentence } from './setup.ts'

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

/** The on-chain allowance on Base as the rails report it, with `remaining` left this period. */
const onchain = (remaining: string): LimitView => ({
  layer: 'onchain',
  period: 'hour',
  limit: '20',
  remaining,
  chain: 'base',
  enforcedBy: 'Base, MetaMask ERC20PeriodTransfer enforcer',
})

describe('the Tempo float source', () => {
  const NOW = Date.parse('2026-10-12T10:00:00Z')
  const signed: ChainSetup = {
    chain: 'base',
    upgraded: true,
    allowance: { perHour: '20', expiresAt: '2026-10-19T10:00:00Z', delegationHash: '0xdd' },
  }
  const source = (overrides: Partial<Parameters<typeof floatSource>[0]> = {}) =>
    floatSource({
      live: true,
      chains: [signed],
      limits: [onchain('20')],
      balances: [usdc('12.5')],
      now: NOW,
      ...overrides,
    })

  test.each<[string, Partial<Parameters<typeof floatSource>[0]>, FloatSource]>([
    ['a signed, unexpired allowance with room and USDC refills it', {}, 'allowance'],
    ['testnets never refill', { live: false }, 'testnet'],
    ['no allowance on Base', { chains: [{ chain: 'base', upgraded: true }] }, 'no_allowance'],
    ['an allowance on another chain only', { chains: [{ ...signed, chain: 'arbitrum' }] }, 'no_allowance'],
    ['an expired allowance', { now: Date.parse('2026-10-20T00:00:00Z') }, 'expired'],
    ['less than the smallest refill and its gas left this period', { limits: [onchain('0.59')] }, 'exhausted'],
    ['exactly the smallest refill and its gas left', { limits: [onchain('0.6')] }, 'allowance'],
    ['an owner with too little USDC on Base', { balances: [usdc('0.2')] }, 'unfunded'],
    ['Base not read: unknown is not empty', { balances: [], limits: [] }, 'allowance'],
  ])('%s', (_name, overrides, expected) => {
    expect(source(overrides)).toBe(expected)
  })

  test('the funding sentence asks for USDC.e by hand only when the allowance cannot refill it', () => {
    const AGENT = '0x4444444444444444444444444444444444444444'
    const empty = { address: AGENT, chain: 'tempo' as const, token: 'USDC.e' as const, held: '0.01' }
    expect(fundingSentence(empty, { source: 'allowance', refilling: false })).toContain(
      "the wallet keeps it topped up from the owner's Base allowance",
    )
    expect(fundingSentence(empty, { source: 'allowance', refilling: false })).not.toContain('send USDC.e')
    expect(fundingSentence(empty, { source: 'exhausted', refilling: true })).toContain('a refill')
    expect(fundingSentence(empty, { source: 'unfunded', refilling: false })).toContain('add USDC on Base')
    expect(fundingSentence(empty, { source: 'expired', refilling: false })).toContain(
      'send USDC.e on Tempo to that address',
    )
    expect(fundingSentence(empty, { source: 'expired', refilling: false })).toContain('has expired')
    expect(fundingSentence(empty, { source: 'exhausted', refilling: false })).toContain('used up for this period')
    expect(fundingSentence(empty, { source: 'no_allowance', refilling: false })).toContain('No Base allowance')
    expect(fundingSentence({ ...empty, held: '2' }, { source: 'no_allowance', refilling: false })).toBeUndefined()
  })
})
