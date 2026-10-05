import { describe, expect, it } from 'vitest'
import {
  appPane,
  closePane,
  draftPane,
  initialPanes,
  openPane,
  parsePanes,
  reconcilePanes,
  syncAppPane,
  threadPane,
  workspaceStorageKey,
} from '../src/lib/workspace-panes.ts'
import { parseWorkspaceDocument, pruneDocument } from '../src/lib/workspace-document.ts'
import { layout, createDocument } from '@danfessler/trellis'
import { PANEL_TYPE } from '../src/lib/trellis-layout.ts'

const main = { id: '1', kind: 'main' as const, keepOpen: false, replies: 0, createdAt: 0 }
const thread = { id: '7', kind: 'thread' as const, keepOpen: false, replies: 0, createdAt: 0 }
const document = () =>
  createDocument(
    layout.row([
      layout.stage(layout.view('purrable-main', { id: 'main' })),
      layout.view(PANEL_TYPE, { id: 'thread:7' }),
    ]),
    { version: 1 },
  )

describe('workspace pane reducers and persistence', () => {
  it('opens distinct threads, focuses existing panes, and never closes main', () => {
    const first = openPane(initialPanes(), threadPane('7'))
    const second = openPane(first, threadPane('8'))
    expect(second.panes.map((pane) => pane.id)).toEqual(['main', 'thread:7', 'thread:8'])
    expect(openPane(second, threadPane('7'))).toMatchObject({ focused: 'thread:7', panes: second.panes })
    expect(closePane(second, 'main')).toBe(second)
    expect(closePane(second, 'missing')).toBe(second)
    expect(closePane(second, 'thread:8')).toMatchObject({ focused: 'main', panes: first.panes })
  })
  it('replaces drafts and preserves thread focus when an app is already open', () => {
    const app = appPane('notes', 'part:3')
    const draft = openPane(initialPanes(), draftPane(42))
    const started = openPane(closePane(draft, 'draft:42'), threadPane('7'))
    const opened = syncAppPane(started, app)
    const focused = openPane(opened, threadPane('7'))
    expect(syncAppPane(reconcilePanes(focused, [main, thread], app), app)).toBe(focused)
    expect(reconcilePanes(focused, [main, thread], undefined)).toEqual(started)
  })
  it('migrates unversioned and v0 state, deduplicates and rejects malformed/future state', () => {
    for (const version of [undefined, 0]) {
      expect(parsePanes(JSON.stringify({ version, threads: ['7', '7', '../bad', 8] })).panes).toEqual([
        initialPanes().panes[0],
        threadPane('7'),
      ])
    }
    expect(parsePanes(JSON.stringify({ version: 99, panes: [threadPane('7')] }))).toEqual(initialPanes())
    expect(parsePanes('x'.repeat(70_000))).toEqual(initialPanes())
    expect(parsePanes('{')).toEqual(initialPanes())
    expect(parsePanes(null)).toEqual(initialPanes())
  })
  it('never restores app authority, drafts or a nonexistent focus from storage', () => {
    expect(
      parsePanes(
        JSON.stringify({
          version: 1,
          panes: [appPane('other', 'x'), draftPane(), threadPane('7')],
          focused: 'app:other:x',
        }),
      ),
    ).toEqual({ panes: [initialPanes().panes[0], threadPane('7')], focused: 'main' })
    expect(workspaceStorageKey('alice', '1')).not.toBe(workspaceStorageKey('bob', '1'))
    expect(workspaceStorageKey('alice', '1')).not.toBe(workspaceStorageKey('alice', '2'))
  })
  it('drops closed and vanished threads while retaining main', () => {
    const state = openPane(openPane(initialPanes(), threadPane('7')), threadPane('8'))
    expect(reconcilePanes(state, [main, { ...thread, closedAt: 10 }], undefined)).toEqual(initialPanes())
    expect(reconcilePanes(state, [main, thread], undefined)).toMatchObject({
      focused: 'main',
      panes: [initialPanes().panes[0], threadPane('7')],
    })
  })
})

describe('bounded Trellis document decoding', () => {
  it('restores v1 and removes stale docked/floating views before mounting', () => {
    const parsed = parseWorkspaceDocument(JSON.stringify(document()))
    expect(parsed?.views.main?.type).toBe('purrable-main')
    if (parsed === undefined) throw new Error('Fixture was rejected')
    const withFloat = {
      ...parsed,
      views: { ...parsed.views, stale: { type: PANEL_TYPE } },
      floating: [
        {
          panel: { kind: 'panel' as const, id: 'floating', views: ['stale'], selected: 'stale' },
          rect: { x: 0, y: 0, w: 300, h: 300 },
          z: 1,
          layer: 'overlay' as const,
        },
      ],
    }
    const pruned = pruneDocument(withFloat, new Set(['main']))
    expect(Object.keys(pruned.views)).toEqual(['main'])
    expect(pruned.floating).toEqual([])
    expect(pruned.root).toMatchObject({ kind: 'stage', child: { views: ['main'] } })
  })
  it('rejects future versions, missing main, main outside stage and invalid weights', () => {
    const value = document()
    expect(parseWorkspaceDocument(JSON.stringify({ ...value, version: 2 }))).toBeUndefined()
    expect(
      parseWorkspaceDocument(JSON.stringify({ ...value, views: { 'thread:7': { type: PANEL_TYPE } } })),
    ).toBeUndefined()
    expect(
      parseWorkspaceDocument(
        JSON.stringify(createDocument(layout.view('purrable-main', { id: 'main' }), { version: 1 })),
      ),
    ).toBeUndefined()
    expect(
      parseWorkspaceDocument(JSON.stringify({ ...value, root: { ...value.root, weights: [-1, 2] } })),
    ).toBeUndefined()
    expect(parseWorkspaceDocument('x'.repeat(129_000))).toBeUndefined()
  })
})
