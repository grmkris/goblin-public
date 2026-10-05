import type { LayoutDocument, LayoutNode, PanelNode, SplitNode } from '@danfessler/trellis'
import { describe, expect, it } from 'vitest'
import {
  PANE_TYPE,
  balanced,
  columnCount,
  insertBeside,
  leafOrder,
  replaceView,
  singlePane,
  swapViews,
  withoutFrame,
  withoutView,
} from '../src/lib/trellis-layout.ts'

const frame = (id: string): PanelNode => ({ kind: 'panel', id, views: [id], selected: id })
const row = (ids: readonly string[]): LayoutDocument => ({
  schema: 1,
  version: 2,
  floating: [],
  hidden: [],
  views: Object.fromEntries(ids.map((id) => [id, { type: PANE_TYPE }])),
  root: { kind: 'split', id: 'row', axis: 'x', weights: ids.map(() => 1 / ids.length), children: ids.map(frame) },
})
function split(node: LayoutNode | null): SplitNode {
  if (node?.kind !== 'split') throw new Error('Fixture needs a split')
  return node
}

describe('one-view pane geometry', () => {
  it('closing gives the removed share to the nearest remaining sibling and collapses a lone child', () => {
    const root = split(row(['a', 'b', 'c']).root)
    expect(withoutFrame(root, 'b')).toMatchObject({ children: [{ id: 'a' }, { id: 'c' }], weights: [1 / 3, 2 / 3] })
    expect(withoutFrame(root, 'missing')).toBe(root)
    expect(withoutFrame(frame('only'), 'only')).toBeNull()
    expect(withoutView(row(['a', 'b']), 'b').root).toMatchObject({ kind: 'panel', id: 'a' })
  })

  it('opens beside a pane: in its row it takes half that pane’s share; across, the two share a new split', () => {
    const wide = insertBeside(row(['a', 'b']), 'a', 'n', 'New', 'right')
    expect(leafOrder(wide)).toEqual(['a', 'n', 'b'])
    expect(split(wide.root).weights).toEqual([0.25, 0.25, 0.5])
    expect(wide.views.n).toEqual({ type: PANE_TYPE, title: 'New' })
    const tall = insertBeside(row(['a', 'b']), 'b', 'n', 'New', 'top')
    expect(leafOrder(tall)).toEqual(['a', 'n', 'b'])
    expect(split(tall.root).children[1]).toMatchObject({ kind: 'split', axis: 'y' })
    expect(columnCount(tall.root)).toBe(2)
    expect(insertBeside(row(['a']), 'missing', 'n', 'New', 'left')).toEqual(row(['a']))
  })

  it('balances rows by their columns, so every column is as wide', () => {
    const tall = insertBeside(row(['a', 'b']), 'b', 'n', 'New', 'bottom')
    const wider = insertBeside(tall, 'n', 'm', 'More', 'right')
    expect(columnCount(wider.root)).toBe(3)
    expect(split(balanced(wider).root).weights).toEqual([1 / 3, 2 / 3])
    expect(balanced(balanced(wider))).toEqual(balanced(wider))
  })

  it('replaces and swaps what panes show, keeping each pane in place', () => {
    const replaced = replaceView(row(['a', 'b']), 'a', 'z', 'Zed')
    expect(leafOrder(replaced)).toEqual(['z', 'b'])
    expect(Object.keys(replaced.views).toSorted()).toEqual(['b', 'z'])
    const swapped = swapViews(row(['a', 'b', 'c']), 'a', 'c')
    expect(leafOrder(swapped)).toEqual(['c', 'b', 'a'])
    expect(split(swapped.root).weights).toEqual(split(row(['a', 'b', 'c']).root).weights)
    expect(swapViews(row(['a']), 'a', 'a')).toEqual(row(['a']))
  })

  it('a single pane is one column', () => {
    expect(columnCount(singlePane('a', 'A').root)).toBe(1)
    expect(leafOrder(singlePane('a', 'A'))).toEqual(['a'])
  })
})
