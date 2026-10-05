import { type LayoutDocument, type LayoutNode, type PanelNode, type SplitNode } from '@danfessler/trellis'
import { describe, expect, it } from 'vitest'
import { balanceAround, evenDocument, withoutFrame, PANEL_TYPE } from '../src/lib/trellis-layout.ts'

const frame = (id: string): PanelNode => ({ kind: 'panel', id, views: [id], selected: id })
const row = (ids: readonly string[]): LayoutDocument => ({
  schema: 1,
  version: 1,
  floating: [],
  hidden: [],
  views: Object.fromEntries(ids.map((id) => [id, { type: PANEL_TYPE }])),
  root: { kind: 'split', id: 'row', axis: 'x', weights: ids.map(() => 1 / ids.length), children: ids.map(frame) },
})
function split(node: LayoutNode | null): SplitNode {
  if (node?.kind !== 'split') throw new Error('Fixture needs a split')
  return node
}

describe('Trellis geometry ported from MyPlan', () => {
  it('balances a newly inserted panel without changing unrelated splits', () => {
    const document = row(['a', 'b', 'c'])
    const lopsided = { ...document, root: { ...split(document.root), weights: [0.2, 0.5, 0.3] } }
    const balanced = balanceAround(lopsided, 'c')
    expect(split(balanced.root).weights).toEqual([1 / 3, 1 / 3, 1 / 3])
    expect(balanceAround(balanced, 'c')).toBe(balanced)
    expect(balanceAround(lopsided, 'missing')).toBe(lopsided)
  })
  it('reset equalizes nested stage splits too', () => {
    const document = row(['a', 'b'])
    const nested = {
      ...document,
      root: { kind: 'stage' as const, id: 'stage', child: { ...split(document.root), weights: [0.1, 0.9] } },
    }
    expect(evenDocument(nested).root).toMatchObject({ child: { weights: [0.5, 0.5] } })
    expect(evenDocument(evenDocument(nested))).toEqual(evenDocument(nested))
  })
  it('closing gives the removed share to the nearest remaining sibling', () => {
    const root = split(row(['a', 'b', 'c']).root)
    expect(withoutFrame(root, 'b')).toMatchObject({ children: [{ id: 'a' }, { id: 'c' }], weights: [1 / 3, 2 / 3] })
    expect(withoutFrame(root, 'c')).toMatchObject({ weights: [1 / 3, 2 / 3] })
    expect(withoutFrame(root, 'missing')).toBe(root)
    expect(withoutFrame(frame('only'), 'only')).toBeNull()
    expect(withoutFrame({ kind: 'stage', id: 'stage', child: frame('only') }, 'only')).toEqual({
      kind: 'stage',
      id: 'stage',
    })
  })
})
