import { describe, expect, it } from 'vitest'
import { intersect, visibleParts, visibleRegions } from '../src/lib/app-occlusion.ts'
const box = { x: 10, y: 20, width: 200, height: 100 }
const area = (regions: ReturnType<typeof visibleRegions>) =>
  regions.reduce((sum, rect) => sum + rect.width * rect.height, 0)
describe('what of a fixed App stage shows', () => {
  it('subtracts overlapping covers once and keeps the remaining regions disjoint', () => {
    const regions = visibleRegions(box, [
      { x: 60, y: 20, width: 100, height: 100 },
      { x: 110, y: 20, width: 100, height: 100 },
    ])
    expect(area(regions)).toBe(5000)
    expect(regions).toEqual([{ x: 10, y: 20, width: 50, height: 100 }])
  })
  it('keeps what nothing covers and hides what is covered completely', () => {
    expect(visibleRegions(box, [{ x: 500, y: 500, width: 10, height: 10 }])).toEqual([box])
    expect(visibleRegions(box, [{ x: 0, y: 0, width: 500, height: 500 }])).toEqual([])
    expect(area(visibleRegions(box, [{ x: 60, y: 45, width: 100, height: 50 }]))).toBe(15000)
  })
  it("stays inside every container that scrolls it, then under its pane's pill", () => {
    expect(intersect(box, { x: 100, y: 0, width: 50, height: 50 })).toEqual({ x: 100, y: 20, width: 50, height: 30 })
    expect(intersect(box, { x: 300, y: 0, width: 50, height: 50 })).toBeUndefined()
    const scroller = { x: 0, y: 60, width: 1000, height: 1000 }
    const pane = { x: 0, y: 0, width: 150, height: 1000 }
    const pill = { x: 0, y: 60, width: 100, height: 20 }
    const parts = visibleParts(box, [scroller, pane], [pill])
    expect(area(parts)).toBe(140 * 60 - 90 * 20)
    expect(visibleParts(box, [{ x: 0, y: 500, width: 10, height: 10 }], [])).toEqual([])
  })
})
