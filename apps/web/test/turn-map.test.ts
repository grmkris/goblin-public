import { describe, expect, it } from 'vitest'
import { currentTurn, markPositions, turnLabel, viewportBand } from '../src/lib/turn-map.ts'

describe('where the marks sit', () => {
  it('places each turn in proportion to where it sits in the transcript', () => {
    expect(markPositions([0, 500, 750], 1000, 200)).toEqual([0, 100, 150])
  })
  it('keeps marks apart when turns are close, without leaving the track', () => {
    expect(markPositions([0, 1, 2], 1000, 100)).toEqual([0, 4, 8])
    expect(markPositions([998, 999, 1000], 1000, 100)).toEqual([92, 96, 100])
  })
  it('spaces the marks evenly when the gaps alone would not fit', () => {
    expect(markPositions([0, 10, 20, 30, 40], 1000, 8)).toEqual([0, 2, 4, 6, 8])
  })
  it('has nothing to place without turns or room', () => {
    expect(markPositions([], 1000, 100)).toEqual([])
    expect(markPositions([10], 0, 100)).toEqual([])
    expect(markPositions([500], 1000, 100)).toEqual([50])
  })
})

describe('the band for what is on screen', () => {
  it('spans the visible share of the transcript at its place', () => {
    expect(viewportBand(250, 250, 1000, 200)).toEqual({ top: 50, size: 50 })
  })
  it('stays visible on a very long transcript', () => {
    expect(viewportBand(0, 10, 100_000, 200).size).toBe(6)
  })
  it('stays inside the track when the tail spacer scrolls past the content', () => {
    expect(viewportBand(900, 250, 1000, 200)).toEqual({ top: 150, size: 50 })
  })
})

describe('the turn being read', () => {
  const offsets = [0, 400, 900]
  it('is the last turn whose top passed the reading line', () => {
    expect(currentTurn(offsets, 450, false)).toBe(1)
    expect(currentTurn(offsets, 400, false)).toBe(1)
  })
  it('is the first before any turn reached the line, and the last at the end', () => {
    expect(currentTurn([100, 400], 50, false)).toBe(0)
    expect(currentTurn(offsets, 450, true)).toBe(2)
    expect(currentTurn([], 0, true)).toBe(-1)
  })
})

describe('a turn as one line', () => {
  it('takes the first line that has words, whitespace collapsed', () => {
    expect(turnLabel('\n  \n  Draft   the\tlaunch email\nand more')).toBe('Draft the launch email')
    expect(turnLabel('   ')).toBe('')
  })
})
