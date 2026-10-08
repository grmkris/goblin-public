import * as Schema from 'effect/Schema'
import { type HomeTile, HomeTileInput } from '@goblin/contracts'
import { expect, it } from 'vitest'
import { HOME_MARK, homeLanding, previewHome } from '../src/lib/home.ts'
import { applyChanges, EMPTY_WORKSPACE, withPendingHome } from '../src/lib/workspace-feed.ts'

it('Main lands on the latest own turn only when it is today in local time', () => {
  const today = new Date(2026, 9, 6, 9)
  const yesterday = new Date(2026, 9, 5, 23)
  expect(homeLanding([], today)).toBe(HOME_MARK)
  expect(homeLanding([{ kind: 'user', id: 'old', text: 'Old', at: yesterday.getTime() }], today)).toBe(HOME_MARK)
  expect(
    homeLanding(
      [
        { kind: 'user', id: 'now', text: 'Now', at: today.getTime() },
        { kind: 'user', id: 'report', text: 'Report', author: 'routine', at: today.getTime() },
      ],
      today,
    ),
  ).toBe('now')
})

it('a delayed Home feed event cannot overwrite a newer layout', () => {
  const first = applyChanges(EMPTY_WORKSPACE, [{ type: 'home', home: { revision: 4, tiles: [] } }])
  const later = applyChanges(first, [{ type: 'home', home: { revision: 3, tiles: [] } }])
  expect(later.home?.revision).toBe(4)
})

it('a dated Markdown and chart snapshot fits the existing bounded Home note', () => {
  const markdown = [
    'Snapshot: 6 October 2026. **Books: 4.**',
    '```chart',
    '{"type":"bar","x":"day","series":[{"key":"books"}],"data":[{"day":"Mon","books":4}]}',
    '```',
  ].join('\n')
  expect(
    Schema.decodeUnknownSync(HomeTileInput)({ kind: 'note', id: 'reading', size: 'large', title: 'Reading', markdown })
      .kind,
  ).toBe('note')
  expect(() =>
    Schema.decodeUnknownSync(HomeTileInput)({
      kind: 'note',
      id: 'huge',
      size: 'small',
      title: 'Huge',
      markdown: '🦉'.repeat(1025),
    }),
  ).toThrow()
})

const tile = (id: string, size: HomeTile['size'] = 'small'): HomeTile => ({
  kind: 'conversations',
  id,
  size,
  placedBy: 'owner',
})
const ids = (tiles: readonly HomeTile[]) => tiles.map((each) => each.id)

it("an owner's Home edit previews as the server applies it", () => {
  const tiles = [tile('a'), tile('b'), tile('c')]
  expect(ids(previewHome(tiles, [{ kind: 'move', id: 'a', index: 2 }]))).toEqual(['b', 'c', 'a'])
  expect(ids(previewHome(tiles, [{ kind: 'move', id: 'c', index: 9 }]))).toEqual(['a', 'b', 'c'])
  expect(previewHome(tiles, [{ kind: 'resize', id: 'b', size: 'wide' }])[1]?.size).toBe('wide')
  expect(ids(previewHome(tiles, [{ kind: 'remove', id: 'b' }]))).toEqual(['a', 'c'])
  expect(
    ids(previewHome(tiles, [{ kind: 'add', tile: { kind: 'conversations', id: 'd', size: 'small' }, index: 1 }])),
  ).toEqual(['a', 'd', 'b', 'c'])
  // What the server would refuse is left to the server: the preview changes nothing for it.
  expect(previewHome(tiles, [{ kind: 'move', id: 'gone', index: 0 }])).toEqual(tiles)
  expect(previewHome(tiles, [{ kind: 'update', id: 'a', title: 'T', markdown: 'M' }])).toEqual(tiles)
  expect(tiles.map((each) => each.id)).toEqual(['a', 'b', 'c'])
})

it('a pending Home edit shows over the feed until the feed reaches its revision', () => {
  const confirmed = applyChanges(EMPTY_WORKSPACE, [
    { type: 'home', home: { revision: 4, tiles: [tile('a'), tile('b')] } },
  ])
  const pending = { until: 5, layout: { revision: 4, tiles: [tile('b'), tile('a')] } }
  const shown = withPendingHome(confirmed, pending)
  expect(shown.settled).toBe(false)
  expect(ids(shown.state.home?.tiles ?? [])).toEqual(['b', 'a'])
  const echoed = applyChanges(confirmed, [{ type: 'home', home: { revision: 5, tiles: [tile('b'), tile('a')] } }])
  expect(withPendingHome(echoed, pending).settled).toBe(true)
  expect(withPendingHome(confirmed, undefined)).toEqual({ state: confirmed, settled: false })
})
