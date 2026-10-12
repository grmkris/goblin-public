import type { WalletStatusResult } from '@goblin/wallet/contract'
import { describe, expect, it } from 'vitest'
import { FRESH_STATUS, ME, STATUS } from '../api/fixtures.ts'
import { holdingsOf, setupStepOf, spendLineOf, totalOf, whereOf } from './home-model.ts'

describe('totalOf', () => {
  it('adds every stablecoin the owner and the agent hold, and never ETH', () => {
    // Base: 1.21 + 62.5, Tempo: 20.5 USDC.e; the ETH rows are gas and stay out.
    expect(totalOf(STATUS)).toEqual({ known: true, usd: '84.21', partial: false })
  })

  it("takes the server's own sum when it sends one, and says when a network was not read", () => {
    const status: WalletStatusResult = {
      ...STATUS,
      status: { ...STATUS.status, stablecoinUsd: '24.50', stablecoinUsdPartial: true },
    }
    expect(totalOf(status)).toEqual({ known: true, usd: '24.5', partial: true })
    expect(totalOf({ ...STATUS, unread: ['tempo'] })).toMatchObject({ partial: true })
  })

  it('is unknown, not zero, when nothing was read', () => {
    expect(totalOf(undefined)).toEqual({ known: false })
    expect(totalOf({ ...STATUS, balances: [] })).toEqual({ known: false })
  })

  it('is a known zero for a read, empty wallet', () => {
    expect(totalOf(FRESH_STATUS)).toEqual({ known: true, usd: '0', partial: false })
  })
})

describe('holdingsOf and whereOf', () => {
  it('lists each stablecoin with the owner and agent apart, Base first', () => {
    expect(holdingsOf(STATUS)).toEqual([
      { chain: 'base', symbol: 'USDC', owner: 62_500_000n, agent: 1_210_000n },
      { chain: 'tempo', symbol: 'USDC.e', owner: 20_500_000n, agent: 0n },
    ])
    expect(whereOf(holdingsOf(STATUS))).toBe('USDC on Base and USDC.e on Tempo')
  })

  it('names one coin on several networks once, and says nothing for an empty wallet', () => {
    const arbitrum = { chain: 'arbitrum', symbol: 'USDC', owner: 1n, agent: 0n } as const
    const base = { chain: 'base', symbol: 'USDC', owner: 1n, agent: 0n } as const
    expect(whereOf([base, arbitrum])).toBe('USDC on Base and Arbitrum')
    expect(whereOf([base])).toBe('USDC on Base')
    expect(whereOf(holdingsOf(FRESH_STATUS))).toBeUndefined()
  })
})

describe('spendLineOf', () => {
  it('says what the agent can spend and the period of the limit that holds it back', () => {
    // Reachable on Base is 1.21 + 12.57 of allowance; the ledger's hourly limit leaves 12.57.
    expect(spendLineOf(STATUS, ME.chains)).toEqual({ tone: 'ok', amount: '$12.57', within: 'this hour' })
  })

  it('says "now" when the funds, not a limit, are what it can reach', () => {
    const status: WalletStatusResult = { ...STATUS, limits: [] }
    expect(spendLineOf(status, [])).toEqual({ tone: 'ok', amount: '$1.21', within: 'now' })
  })

  it('points an empty wallet at Add funds', () => {
    expect(spendLineOf(FRESH_STATUS, [])).toEqual({
      tone: 'blocked',
      text: 'Add USDC on Base so your agent can spend.',
      next: { label: 'Add funds', to: '/add-funds' },
    })
  })

  it('points an agent without a wallet at setup', () => {
    const status: WalletStatusResult = { ...STATUS, agent: { address: '0x0000000000000000000000000000000000000000' } }
    expect(spendLineOf(status, [])).toMatchObject({ tone: 'blocked', next: { to: '/setup' } })
  })

  it('says when access has ended', () => {
    const status: WalletStatusResult = { ...STATUS, status: { ...STATUS.status, expiresAt: '2020-01-01T00:00:00Z' } }
    expect(spendLineOf(status, ME.chains)).toEqual({
      tone: 'blocked',
      text: "Your agent's access has ended.",
      next: { label: 'Review limits', to: '/limits' },
    })
  })
})

describe('setupStepOf', () => {
  it('numbers the next step of four', () => {
    expect(setupStepOf('agent')).toMatchObject({ number: 1, of: 4 })
    expect(setupStepOf('allowance')).toMatchObject({ number: 4, of: 4 })
  })
})
