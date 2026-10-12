import { describe, expect, it } from 'vitest'
import { spendableUsd, sumUsd } from './money.ts'

const row = (balance: string, symbol = 'USDC') => ({
  chain: 'base' as const,
  symbol,
  token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  decimals: 6,
  balance,
  holder: 'agent' as const,
  address: '0x9aC3e1D5b7F20846c1A9d3E5f7B2048a6C1e9D3b',
})

describe('sumUsd', () => {
  it('adds exact decimals', () => {
    expect(sumUsd([row('0.1'), row('0.2')])).toBe('0.3')
    expect(sumUsd([row('12.5'), row('0.007'), row('5')])).toBe('17.507')
    expect(sumUsd([])).toBe('0')
  })
})

describe('dollars are stablecoins only', () => {
  it('leaves ETH out of the dollars held and the spendable figure', () => {
    expect(sumUsd([row('10.162533'), row('0.0054', 'ETH'), row('2', 'USDC.e')])).toBe('12.162533')
    expect(
      spendableUsd([
        { symbol: 'ETH', spendable: '0.006' },
        { symbol: 'USDC', spendable: '10.155533' },
      ]),
    ).toBe('10.155533')
    expect(spendableUsd([{ symbol: 'ETH', spendable: '1' }])).toBe('0')
  })
})
