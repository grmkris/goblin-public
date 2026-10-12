import { describe, expect, it } from 'vitest'
import { byMicros, isStable, microsOf, minMicros, sumMicros, unitsOf, usdOf } from './money.ts'

describe('micro-dollars', () => {
  it('adds exact decimals without floating point', () => {
    expect(usdOf(sumMicros([microsOf('0.1'), microsOf('0.2')]))).toBe('0.3')
    expect(usdOf(sumMicros([microsOf('12.5'), microsOf('0.007'), microsOf('5')]))).toBe('17.507')
    expect(usdOf(sumMicros([]))).toBe('0')
  })
  it('keeps a micro-charge exact and a large balance whole', () => {
    expect(microsOf('0.007')).toBe(7_000n)
    expect(usdOf(microsOf('0.000001'))).toBe('0.000001')
    expect(usdOf(microsOf('123456789.123456'))).toBe('123456789.123456')
  })
  it('cuts digits past the sixth decimal instead of rounding them up', () => {
    expect(microsOf('0.0000019')).toBe(1n)
    expect(microsOf('0.0000009')).toBe(0n)
  })
  it('finds the smallest and sorts', () => {
    expect(minMicros([5n, 2n, 9n])).toBe(2n)
    expect(minMicros([])).toBeUndefined()
    expect([3n, 1n, 2n].toSorted(byMicros)).toEqual([1n, 2n, 3n])
  })
})

describe('what counts as dollars', () => {
  it('counts the stablecoins and leaves ETH out', () => {
    expect(isStable('USDC')).toBe(true)
    expect(isStable('USDC.e')).toBe(true)
    expect(isStable('pathUSD')).toBe(true)
    expect(isStable('ETH')).toBe(false)
  })
  it('reads gas in its own 18 decimals', () => {
    expect(unitsOf('0.000597817944927921', 18)).toBe(597_817_944_927_921n)
    expect(unitsOf('0', 18)).toBe(0n)
  })
})
