import { describe, expect, it } from 'vitest'
import { localInput, localInstant } from '../src/lib/local-time.ts'

describe('local time', () => {
  it('turns a picked wall time into the same instant with an explicit offset', () => {
    const instant = localInstant('2027-03-14T09:30')
    expect(instant).toMatch(/^2027-03-14T09:30:00[+-]\d{2}:\d{2}$/u)
    expect(Date.parse(instant ?? '')).toBe(new Date('2027-03-14T09:30').getTime())
  })

  it('refuses what is not a time', () => {
    expect(localInstant('')).toBeUndefined()
    expect(localInstant('tomorrow at nine')).toBeUndefined()
  })

  it('shows a stored instant back as the wall time it was picked as', () => {
    expect(localInput(localInstant('2027-07-01T18:05') ?? '')).toBe('2027-07-01T18:05')
    expect(localInput('not a time')).toBe('')
  })
})
