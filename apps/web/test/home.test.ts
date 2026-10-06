import { expect, it } from 'vitest'
import { HOME_MARK, homeLanding } from '../src/lib/home.ts'
import { applyChanges, EMPTY_WORKSPACE } from '../src/lib/workspace-feed.ts'

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
