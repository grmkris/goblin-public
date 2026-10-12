import { describe, expect, it } from 'vitest'
import {
  formatToken,
  formatTokenCompact,
  formatUsd,
  formatUsdCompact,
  shortAddress,
  timeAgo,
  timeUntil,
} from './format.ts'

describe('formatUsd', () => {
  it('shows exactly what was charged', () => {
    expect(formatUsd('0.007')).toBe('$0.007')
    expect(formatUsd('0.012')).toBe('$0.012')
    expect(formatUsd('0.000001')).toBe('$0.000001')
  })
  it('always shows cents and groups thousands', () => {
    expect(formatUsd('5')).toBe('$5.00')
    expect(formatUsd('0.05')).toBe('$0.05')
    expect(formatUsd('1234.5')).toBe('$1,234.50')
    expect(formatUsd('20.000000')).toBe('$20.00')
  })
})

describe('formatToken', () => {
  it('drops trailing zeros', () => {
    expect(formatToken('12.500000')).toBe('12.5')
    expect(formatToken('12')).toBe('12')
  })
})

describe('formatUsdCompact', () => {
  it('shows a balance in cents, cut down rather than rounded up', () => {
    expect(formatUsdCompact('10.155533')).toBe('$10.15')
    expect(formatUsdCompact('1234.999999')).toBe('$1,234.99')
    expect(formatUsdCompact('5')).toBe('$5.00')
    expect(formatUsdCompact('0')).toBe('$0.00')
  })
  it('never turns a positive amount below a cent into zero', () => {
    expect(formatUsdCompact('0.007')).toBe('$0.007')
    expect(formatUsdCompact('0.000001')).toBe('$0.000001')
    expect(formatUsdCompact('0.0123')).toBe('$0.01')
  })
})

describe('formatTokenCompact', () => {
  it('keeps four significant digits of a small quantity', () => {
    expect(formatTokenCompact('0.000597817944927921')).toBe('0.0005978')
    expect(formatTokenCompact('0.005399666120503803')).toBe('0.005399')
    expect(formatTokenCompact('0.0054')).toBe('0.0054')
  })
  it('keeps four decimals of a larger one and drops trailing zeros', () => {
    expect(formatTokenCompact('1.23456789')).toBe('1.2345')
    expect(formatTokenCompact('12.500000')).toBe('12.5')
    expect(formatTokenCompact('1500')).toBe('1,500')
    expect(formatTokenCompact('0')).toBe('0')
  })
})

describe('shortAddress', () => {
  it('keeps the ends', () => {
    expect(shortAddress('0x4f1B7c0a2D9e3b86A5c1E7f09d4B2a6C8e3F5a17')).toBe('0x4f1B…5a17')
  })
})

describe('relative time', () => {
  const now = Date.parse('2026-10-12T12:00:00Z')
  it('counts back and forward', () => {
    expect(timeAgo('2026-10-12T11:55:00Z', now)).toBe('5 min ago')
    expect(timeAgo('2026-10-12T11:59:50Z', now)).toBe('just now')
    expect(timeUntil('2026-10-12T12:41:00Z', now)).toBe('in 41 min')
    expect(timeUntil('2026-10-12T11:00:00Z', now)).toBe('now')
  })
})
