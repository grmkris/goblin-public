import { describe, expect, it } from 'vitest'
import { LIVE_APPS, evictions } from '../src/lib/app-residency.ts'

const resident = (id: string, seenAt: number, visible = false) => ({ id, seenAt, visible })

describe('which App iframes stay loaded', () => {
  it('keeps every App while there are no more than the cap', () => {
    const six = Array.from({ length: LIVE_APPS }, (_, index) => resident(String(index), index))
    expect(evictions(six)).toEqual([])
  })
  it('unloads the least recently seen beyond the cap', () => {
    const residents = [resident('a', 50), resident('b', 10), resident('c', 30), resident('d', 20)]
    expect(evictions(residents, 2)).toEqual(['b', 'd'])
  })
  it('never unloads an App on screen, even when that leaves more than the cap', () => {
    const residents = [resident('a', 1, true), resident('b', 2, true), resident('c', 3), resident('d', 4, true)]
    expect(evictions(residents, 2)).toEqual(['c'])
    expect(
      evictions(
        residents.map((item) => ({ ...item, visible: true })),
        2,
      ),
    ).toEqual([])
  })
})
