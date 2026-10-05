import { describe, expect, it } from 'vitest'
import { columnCount, leafOrder } from '../src/lib/trellis-layout.ts'
import {
  MAIN_KEY,
  closeItem,
  conversationKey,
  draftKey,
  initialWorkspace,
  itemOf,
  maximizeItem,
  openItem,
  order,
  parseWorkspace,
  prune,
  replaceItem,
  resized,
  serializeWorkspace,
  type WorkspaceState,
} from '../src/lib/workspace.ts'

const c = conversationKey
const open = (state: WorkspaceState, key: string, where: Parameters<typeof openItem>[3] = 'beside') =>
  openItem(state, key, key, where)

/** The weights of the root split, rounded. */
const weights = (state: WorkspaceState) => {
  const { root } = state.doc
  return root?.kind === 'split' ? root.weights.map((weight) => Math.round(weight * 1000) / 1000) : [1]
}

describe('item keys', () => {
  it('name conversations, Apps and drafts, and nothing else', () => {
    expect(itemOf('c:7')).toEqual({ kind: 'conversation', id: '7' })
    expect(itemOf('a:4')).toEqual({ kind: 'app', id: '4' })
    expect(itemOf('d:new')).toEqual({ kind: 'draft' })
    expect(itemOf(draftKey({ conversation: '1', entry: 40 }))).toEqual({
      kind: 'draft',
      from: { conversation: '1', entry: 40 },
    })
    for (const bad of ['c:x', 'c:7:1', 'd:1:0', 'd:1:x', 'z:1', 'c:', 'a:', 'a:app-1'] as const)
      expect(itemOf(bad)).toBeUndefined()
  })
})

describe('opening items', () => {
  it('opens beside the focused pane with even columns, and focuses what is already open', () => {
    let state = open(initialWorkspace(), c('7'))
    state = open(state, c('9'))
    expect(order(state)).toEqual([MAIN_KEY, c('7'), c('9')])
    expect(state.focused).toBe(c('9'))
    expect(weights(state)).toEqual([0.333, 0.333, 0.333])
    const again = open({ ...state, focused: MAIN_KEY }, c('7'))
    expect(order(again)).toEqual(order(state))
    expect(again.focused).toBe(c('7'))
  })

  it('shows an item here in place of the focused one, which goes', () => {
    const state = open(open(initialWorkspace(), c('7')), c('9'), 'here')
    expect(order(state)).toEqual([MAIN_KEY, c('9')])
    expect(state.focused).toBe(c('9'))
  })

  it('splits a pane at an edge, moving an item that is already open', () => {
    const three = open(open(initialWorkspace(), c('7')), c('9'))
    const below = open(three, c('9'), { target: MAIN_KEY, edge: 'bottom' })
    expect(order(below)).toEqual([MAIN_KEY, c('9'), c('7')])
    expect(columnCount(below.doc.root)).toBe(2)
    const above = open(below, c('5'), { target: c('7'), edge: 'top' })
    expect(order(above)).toEqual([MAIN_KEY, c('9'), c('5'), c('7')])
  })

  it('drops onto a pane: an open item trades places, a new one replaces what it showed', () => {
    const two = open(initialWorkspace(), c('7'))
    expect(order(open(two, MAIN_KEY, { into: c('7') }))).toEqual([c('7'), MAIN_KEY])
    expect(order(open(two, c('9'), { into: MAIN_KEY }))).toEqual([c('9'), c('7')])
    expect(open(two, c('7'), { into: c('7') }).doc).toBe(two.doc)
  })
})

describe('closing and replacing', () => {
  it('never closes the last pane, and moves focus to the pane before', () => {
    expect(closeItem(initialWorkspace(), MAIN_KEY)).toEqual(initialWorkspace())
    const state = open(open(initialWorkspace(), c('7')), c('9'))
    const closed = closeItem(state, c('9'))
    expect(order(closed)).toEqual([MAIN_KEY, c('7')])
    expect(closed.focused).toBe(c('7'))
    expect(weights(closed)).toEqual([0.5, 0.5])
    const mainClosed = closeItem(closed, MAIN_KEY)
    expect(order(mainClosed)).toEqual([c('7')])
  })

  it('turns a draft into its thread in the same place', () => {
    const draft = draftKey({ conversation: '1', entry: 40 })
    const state = replaceItem(open(open(initialWorkspace(), draft), c('9')), draft, c('12'), 'Trip')
    expect(order(state)).toEqual([MAIN_KEY, c('12'), c('9')])
  })

  it('prunes what is gone, and falls back to main when nothing is left', () => {
    const state = open(open(initialWorkspace(), c('7')), c('9'))
    expect(order(prune(state, (key) => key !== c('7')))).toEqual([MAIN_KEY, c('9')])
    expect(prune(state, () => false)).toEqual(initialWorkspace())
  })

  it('maximizes one pane until the next structural change', () => {
    const state = maximizeItem(open(initialWorkspace(), c('7')), MAIN_KEY)
    expect(state.maximized).toBe(MAIN_KEY)
    expect(open(state, c('9')).maximized).toBeUndefined()
    expect(maximizeItem(state, undefined).maximized).toBeUndefined()
  })

  it('takes a resize from Trellis only when it shows the same items', () => {
    const state = open(initialWorkspace(), c('7'))
    expect(resized(state, initialWorkspace().doc)).toBe(state)
  })
})

describe('the stored workspace', () => {
  it('brings back conversation and App panes and their focus, never drafts', () => {
    let state = open(open(initialWorkspace(), c('7')), 'a:4')
    state = openItem(state, draftKey(), 'New thread', 'beside', c('7'))
    const parsed = parseWorkspace(serializeWorkspace(state))
    expect(parsed === undefined ? [] : leafOrder(parsed.doc)).toEqual([MAIN_KEY, c('7'), 'a:4'])
    expect(parsed?.focused).toBe(MAIN_KEY)
  })

  it('refuses another version, oversized or malformed data', () => {
    const doc = { ...initialWorkspace().doc, version: 1 }
    expect(parseWorkspace(JSON.stringify({ doc, focused: MAIN_KEY }))).toBeUndefined()
    expect(parseWorkspace('x'.repeat(128_001))).toBeUndefined()
    expect(parseWorkspace('{')).toBeUndefined()
    expect(parseWorkspace(null)).toBeUndefined()
  })
})
