import type { HomeOperation, HomeTile } from '@goblin/contracts'
import type { Part } from './parts.ts'
import { isOwnTurn } from './parts.ts'

export const HOME_MARK = 'home-surface'
/** Main resumes today's own turn; an older or empty conversation opens the desk below it. */
export function homeLanding(parts: readonly Part[], now = new Date()): string {
  const latest = parts.filter(isOwnTurn).at(-1)
  const at = latest?.at === undefined ? undefined : new Date(latest.at)
  return at?.toDateString() === now.toDateString() ? (latest?.id ?? HOME_MARK) : HOME_MARK
}
/** A presentation event only. The listener uses the scroller's commands, never transcript state. */
export function showHome(ids: readonly string[] = []): void {
  window.dispatchEvent(new CustomEvent('goblin-home-show', { detail: [...ids] }))
}

/**
 * Home's tiles after an owner's `ops`, as the server will apply them (`runtime/src/home/operations.ts`), so an edit
 * shows before the server confirms it. An op the server would refuse (a tile it cannot find, an id taken, an update to
 * anything but a note) is skipped here: the server stays the authority and its answer replaces this preview.
 */
export function previewHome(tiles: readonly HomeTile[], ops: readonly HomeOperation[]): readonly HomeTile[] {
  const next = [...tiles]
  for (const op of ops) previewOne(next, op)
  return next
}

function previewOne(tiles: HomeTile[], op: HomeOperation): void {
  if (op.kind === 'add') {
    if (!tiles.some((tile) => tile.id === op.tile.id))
      tiles.splice(Math.min(op.index ?? tiles.length, tiles.length), 0, { ...op.tile, placedBy: 'owner' })
    return
  }
  const index = tiles.findIndex((tile) => tile.id === op.id)
  const tile = tiles[index]
  if (tile === undefined) return
  if (op.kind === 'move') {
    tiles.splice(index, 1)
    tiles.splice(Math.min(op.index, tiles.length), 0, tile)
  } else if (op.kind === 'resize') tiles[index] = { ...tile, size: op.size }
  else if (op.kind === 'remove') tiles.splice(index, 1)
  else if (tile.kind === 'note') tiles[index] = { ...tile, title: op.title, markdown: op.markdown }
}
