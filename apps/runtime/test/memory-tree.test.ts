import { describe, expect, it } from 'vitest'
import { type Node, address, firstOf, fold, nodeAt, nodeKey, spanOf } from '../src/memory/tree.ts'

/** Every node over `total` messages built, each text `bytes` long; `top` caps the levels built. */
function built(total: number, bytes: number, top = 20): Map<string, number> {
  const sizes = new Map<string, number>()
  for (let level = 0; level <= top && 2 ** level <= total; level += 1)
    for (let index = 0; (index + 1) * 2 ** level <= total; index += 1) sizes.set(nodeKey({ level, index }), bytes)
  return sizes
}

const addresses = (parts: readonly Node[]) => parts.map(address)

describe('the memory view (OptChat fold)', () => {
  it('keeps one line per message while the view fits', () => {
    const view = fold(5, built(5, 10), 1000)
    expect(addresses(view.parts)).toEqual(['0+1', '1+1', '2+1', '3+1', '4+1'])
    expect(view.wanted).toBeUndefined()
  })

  it('fits the budget by coarsening the oldest messages first, and changes mostly near its end', () => {
    const view = fold(100, built(101, 40), 1200)
    expect(view.bytes).toBeLessThanOrEqual(1200)
    // The parts tile [0, 100) in order, and older parts cover at least as many messages as newer ones.
    expect(view.parts.map(firstOf)).toEqual(
      view.parts.map((_, at) => view.parts.slice(0, at).reduce((n, p) => n + spanOf(p), 0)),
    )
    expect(view.parts.reduce((n, part) => n + spanOf(part), 0)).toBe(100)
    expect(view.parts.map(spanOf)).toEqual(view.parts.map(spanOf).toSorted((a, b) => b - a))
    const next = fold(101, built(101, 40), 1200)
    const shared = view.parts.findIndex((part, at) => address(part) !== address(next.parts[at] ?? part))
    expect(shared === -1 ? view.parts.length : shared).toBeGreaterThan(view.parts.length / 2)
  })

  it('names the merge it waits for instead of exceeding the budget silently', () => {
    const view = fold(8, built(8, 40, 0), 200)
    expect(addresses(view.parts)).toHaveLength(8)
    expect(view.wanted).toEqual({ level: 1, index: 0 })
  })

  it('reads `id+n` addresses only where a node is', () => {
    expect(nodeAt(8, 4)).toEqual({ level: 2, index: 2 })
    expect(nodeAt(3, 1)).toEqual({ level: 0, index: 3 })
    expect(nodeAt(6, 4)).toBeUndefined()
    expect(nodeAt(0, 3)).toBeUndefined()
  })
})
