import { describe, expect, test } from 'vitest'
import { formatUnits, microsToUsd, parseUnits, usdToMicros } from './index.ts'

describe('parseUnits', () => {
  test.each([
    ['0', 6, 0n],
    ['1', 6, 1_000_000n],
    ['1.5', 6, 1_500_000n],
    ['0.000001', 6, 1n],
    ['007.10', 6, 7_100_000n],
    ['123456789012345678.123456789012345678', 18, 123456789012345678123456789012345678n],
    ['5', 0, 5n],
  ] as const)('%s at %i decimals is %s', (value, decimals, expected) => {
    expect(parseUnits(value, decimals)).toBe(expected)
  })

  test.each(['', ' ', '1e3', '-1', '+1', '1.', '.5', '1,5', '0x10', 'NaN', '1 ', '1.2.3'])('rejects %j', (value) => {
    expect(() => parseUnits(value, 6)).toThrow(/not a plain decimal/u)
  })

  test('rejects more decimals than allowed, even zeros', () => {
    expect(() => parseUnits('1.0000001', 6)).toThrow(/more than 6/u)
    expect(() => parseUnits('1.0', 0)).toThrow(/more than 0/u)
  })

  test('rejects a number passed where a string belongs', () => {
    // @ts-expect-error a float must not type check, and must not work at runtime
    expect(() => parseUnits(1.5, 6)).toThrow(/decimal string/u)
  })

  test('rejects nonsense decimals', () => {
    expect(() => parseUnits('1', -1)).toThrow(/decimals/u)
    expect(() => parseUnits('1', 1.5)).toThrow(/decimals/u)
    expect(() => parseUnits('1', 37)).toThrow(/decimals/u)
  })
})

describe('formatUnits', () => {
  test.each([
    [0n, 6, '0'],
    [1n, 6, '0.000001'],
    [1_500_000n, 6, '1.5'],
    [2_000_000n, 6, '2'],
    [10n, 0, '10'],
  ] as const)('%s at %i decimals is %s', (units, decimals, expected) => {
    expect(formatUnits(units, decimals)).toBe(expected)
  })

  test('rejects negative amounts', () => {
    expect(() => formatUnits(-1n, 6)).toThrow(/negative/u)
  })

  test('round-trips', () => {
    for (const value of ['0', '0.1', '12.345678', '999999999.999999'])
      expect(formatUnits(parseUnits(value, 6), 6)).toBe(value)
  })
})

describe('micro-dollars', () => {
  test('convert both ways', () => {
    expect(usdToMicros('12.34')).toBe(12_340_000n)
    expect(microsToUsd(12_340_000n)).toBe('12.34')
    expect(() => usdToMicros('0.0000001')).toThrow(/more than 6/u)
  })
})
