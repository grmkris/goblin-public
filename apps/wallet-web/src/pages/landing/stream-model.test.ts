import { describe, expect, it } from 'vitest'
import { BEATS, isAsking, SETTLED, streamAt } from './stream-model.ts'

const verdicts = (step: number, answer?: 'approved' | 'declined') =>
  streamAt(step, answer).rows.map((row) => row.verdict)

describe('streamAt', () => {
  it('starts empty and plays one beat at a time', () => {
    expect(verdicts(0)).toEqual(['hidden', 'hidden', 'hidden'])
    expect(verdicts(1)).toEqual(['checking', 'hidden', 'hidden'])
    expect(verdicts(2)).toEqual(['paid', 'hidden', 'hidden'])
    expect(verdicts(4)).toEqual(['paid', 'refused', 'hidden'])
    expect(verdicts(BEATS.length)).toEqual(['paid', 'refused', 'asking'])
  })

  it('names the layer that refused or asked, once it has, and none for a payment that fit', () => {
    expect(streamAt(3, undefined).rows.map((row) => row.layer)).toEqual([undefined, undefined, undefined])
    expect(streamAt(BEATS.length, undefined).rows.map((row) => row.layer)).toEqual([undefined, 'signer', 'ledger'])
    expect(SETTLED.rows.map((row) => row.layer)).toEqual([undefined, 'signer', 'ledger'])
  })

  it("settles the ask by the owner's answer", () => {
    expect(verdicts(BEATS.length, 'approved')).toEqual(['paid', 'refused', 'paid'])
    expect(verdicts(BEATS.length, 'declined')).toEqual(['paid', 'refused', 'declined'])
  })

  it('counts only what was paid against the hour, exactly', () => {
    expect(streamAt(2, undefined).usedThisHour).toBe('0.007')
    expect(streamAt(BEATS.length, 'declined').usedThisHour).toBe('0.007')
    expect(SETTLED.usedThisHour).toBe('1.007')
    expect(SETTLED.hourLimit).toBe('20')
  })

  it('asks only once the ask has arrived and until it is answered', () => {
    expect(isAsking(BEATS.length - 1, undefined)).toBe(false)
    expect(isAsking(BEATS.length, undefined)).toBe(true)
    expect(isAsking(BEATS.length, 'approved')).toBe(false)
  })

  it('plays its beats in order', () => {
    const times = BEATS.map((beat) => beat.at)
    expect(times).toEqual(times.toSorted((a, b) => a - b))
  })
})
