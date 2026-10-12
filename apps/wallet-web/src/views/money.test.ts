import { describe, expect, it } from 'vitest'
import { sumUsd } from './money.ts'

const row = (balance: string) => ({
  chain: 'base' as const,
  symbol: 'USDC',
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
