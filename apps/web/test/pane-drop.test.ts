import { describe, expect, it } from 'vitest'
import { planDrop, previewBox, zoneOf } from '../src/lib/pane-drop.ts'

const box = { left: 100, top: 100, width: 800, height: 600 }

describe('drop zones', () => {
  it('splits near an edge (28% of the size, at most 96px) and opens in the middle', () => {
    expect(zoneOf(box, 150, 400)).toBe('left')
    expect(zoneOf(box, 880, 400)).toBe('right')
    expect(zoneOf(box, 500, 120)).toBe('top')
    expect(zoneOf(box, 500, 690)).toBe('bottom')
    expect(zoneOf(box, 500, 400)).toBe('center')
    expect(zoneOf(box, 99, 400)).toBeUndefined()
    // In a corner the nearer edge wins.
    expect(zoneOf(box, 105, 130)).toBe('left')
  })

  it('caps the band for big panes and scales it for small ones', () => {
    expect(zoneOf({ left: 0, top: 0, width: 2000, height: 600 }, 150, 300)).toBe('center')
    expect(zoneOf({ left: 0, top: 0, width: 200, height: 600 }, 50, 300)).toBe('left')
  })
})

describe('drop plans', () => {
  const base = { item: 'c:7', target: 'c:1', box, open: false, scrolls: false }

  it('splits at an edge when both halves keep their minimum, else refuses', () => {
    expect(planDrop({ ...base, zone: 'right' })).toEqual({ kind: 'split', target: 'c:1', edge: 'right' })
    expect(planDrop({ ...base, zone: 'right', box: { ...box, width: 600 } })).toEqual({ kind: 'refused' })
    expect(planDrop({ ...base, zone: 'right', box: { ...box, width: 600 }, scrolls: true }).kind).toBe('split')
    expect(planDrop({ ...base, zone: 'bottom', box: { ...box, height: 400 } })).toEqual({ kind: 'refused' })
  })

  it('opens in the middle, trades places when the item is open, and never drops a pane on itself', () => {
    expect(planDrop({ ...base, zone: 'center' })).toEqual({ kind: 'into', target: 'c:1', swap: false })
    expect(planDrop({ ...base, zone: 'center', open: true })).toEqual({ kind: 'into', target: 'c:1', swap: true })
    expect(planDrop({ ...base, item: 'c:1', zone: 'left' })).toEqual({ kind: 'refused' })
  })

  it('previews the half a split fills, or the whole pane', () => {
    expect(previewBox(box, { kind: 'split', target: 'c:1', edge: 'right' })).toEqual({ ...box, left: 500, width: 400 })
    expect(previewBox(box, { kind: 'split', target: 'c:1', edge: 'top' })).toEqual({ ...box, height: 300 })
    expect(previewBox(box, { kind: 'into', target: 'c:1', swap: false })).toEqual(box)
    expect(previewBox(box, { kind: 'refused' })).toBeUndefined()
  })
})
