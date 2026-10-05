import { describe, expect, it } from 'vitest'
import { visibleRegions } from '../src/lib/app-occlusion.ts'
const box = { x: 10, y: 20, width: 200, height: 100 }
const area = (regions: ReturnType<typeof visibleRegions>) =>
  regions.reduce((sum, rect) => sum + rect.width * rect.height, 0)
describe('fixed App stage respects overlapping floating panes', () => {
  it('subtracts overlapping blockers once and keeps the remaining regions disjoint', () => {
    const regions = visibleRegions(box, [
      { x: 60, y: 20, width: 100, height: 100 },
      { x: 110, y: 20, width: 100, height: 100 },
    ])
    expect(area(regions)).toBe(5000)
    expect(regions).toEqual([{ x: 10, y: 20, width: 50, height: 100 }])
  })
  it('retains unrelated panes and clips completely covered panes', () => {
    expect(visibleRegions(box, [{ x: 500, y: 500, width: 10, height: 10 }])).toEqual([box])
    expect(visibleRegions(box, [{ x: 0, y: 0, width: 500, height: 500 }])).toEqual([])
    expect(area(visibleRegions(box, [{ x: 60, y: 45, width: 100, height: 50 }]))).toBe(15000)
  })
})
