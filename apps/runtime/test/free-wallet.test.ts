import { describe, expect, it } from 'vitest'
import type { WalletStatus } from '@goblin/contracts'
import { freeWalletUsd, stablecoinDollars } from '../src/layers/budget.ts'

const status = (tokens: WalletStatus['tokens']): WalletStatus => ({
  kind: 'wallet',
  paid: 'ready',
  funding: 'ready',
  tokens,
})

describe('the free plan asks for a funded Goblin Wallet (ADR 0047)', () => {
  it('reads the dollars a stage asks for, and anything unreadable as none', () => {
    expect([freeWalletUsd('5'), freeWalletUsd('2.5')]).toEqual([5, 2.5])
    for (const none of [undefined, '', '0', '-1', 'five']) expect(freeWalletUsd(none), String(none)).toBe(0)
  })

  it("counts a wallet's USDC and USDC.e only, owner and agent together as its status line sums them", () => {
    expect(
      stablecoinDollars(
        status([
          { symbol: 'USDC', balance: '3.10' },
          { symbol: 'USDC.e', balance: '1.979224' },
          { symbol: 'ETH', balance: '0.012' },
          { symbol: 'USDC', balance: 'unreadable' },
        ]),
      ),
    ).toBeCloseTo(5.079224, 6)
    expect(stablecoinDollars(status([{ symbol: 'USDC.e' }]))).toBe(0)
  })
})
