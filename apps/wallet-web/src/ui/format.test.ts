import { describe, expect, it } from 'vitest'
import { formatToken, formatUsd, shortAddress, timeAgo, timeUntil } from './format.ts'

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
