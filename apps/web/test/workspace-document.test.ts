import { describe, expect, it } from 'vitest'
import type { LayoutDocument } from '@danfessler/trellis'
import { LAYOUT_VERSION, PANE_TYPE, insertBeside, leafOrder, singlePane } from '../src/lib/trellis-layout.ts'
import { parseLayoutDocument } from '../src/lib/workspace-document.ts'

const all = () => true
const two = (): LayoutDocument => insertBeside(singlePane('c:1', 'Main'), 'c:1', 'c:7', 'Trip', 'right')
const roundTrip = (doc: unknown, keep: (view: string) => boolean = all) =>
  parseLayoutDocument(JSON.parse(JSON.stringify(doc)), keep)

describe('bounded stored layouts', () => {
  it('reads back a layout of one-view panes, keeping only the views `keep` accepts', () => {
    expect(leafOrder(roundTrip(two()) ?? singlePane('x', 'x'))).toEqual(['c:1', 'c:7'])
    const kept = roundTrip(two(), (view) => view !== 'c:7')
    expect(kept === undefined ? [] : leafOrder(kept)).toEqual(['c:1'])
    expect(roundTrip(two(), () => false)).toBeUndefined()
  })

  it('refuses another version, a stage, a tabbed panel, a foreign type or too many views', () => {
    const doc = two()
    expect(roundTrip({ ...doc, version: LAYOUT_VERSION + 1 })).toBeUndefined()
    expect(roundTrip({ ...doc, root: { kind: 'stage', id: 's', child: doc.root } })).toBeUndefined()
    expect(
      roundTrip({ ...doc, root: { kind: 'panel', id: 'p', views: ['c:1', 'c:7'], selected: 'c:1' } }),
    ).toBeUndefined()
    expect(roundTrip({ ...doc, views: { ...doc.views, 'c:7': { type: 'other' } } })).toBeUndefined()
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, n) => [`c:${n}`, { type: PANE_TYPE }]))
    expect(roundTrip({ ...doc, views: many })).toBeUndefined()
  })

  it('refuses invalid weights and drops anything floating', () => {
    const doc = two()
    const root = doc.root?.kind === 'split' ? doc.root : undefined
    expect(roundTrip({ ...doc, root: { ...root, weights: [-1, 2] } })).toBeUndefined()
    const floating = [{ panel: { kind: 'panel', id: 'f', views: ['c:9'], selected: 'c:9' }, rect: {}, z: 1 }]
    expect(roundTrip({ ...doc, floating })?.floating).toEqual([])
  })
})
