import { describe, expect, it } from 'vitest'
import { dateTime, pad } from '../src/lib/format.ts'

describe('how the web writes times', () => {
  it('pads a month, day, hour or minute to two digits', () => {
    expect(pad(7)).toBe('07')
    expect(pad(12)).toBe('12')
  })

  it("writes a date and time in a routine's own zone when it names one", () => {
    const at = Date.UTC(2026, 9, 10, 23, 30)
    expect(dateTime(at, 'UTC')).toContain('10')
    expect(dateTime(at, 'Asia/Tokyo')).toContain('11')
  })
})
