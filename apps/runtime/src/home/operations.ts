import { HomeLayout, type HomeOperation, type HomeTile } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { InvalidInput, NotFound } from '../http/errors.ts'

/** Pure ordered edits. Placement changes presentation and never touches grants or App state. */
export function applyHomeOperations(
  layout: HomeLayout,
  ops: readonly HomeOperation[],
  actor: HomeTile['placedBy'],
): HomeLayout {
  const tiles = [...layout.tiles]
  for (const op of ops) apply(tiles, op, actor)
  return Schema.decodeSync(HomeLayout)({ revision: layout.revision + 1, tiles })
}

function apply(tiles: HomeTile[], op: HomeOperation, actor: HomeTile['placedBy']): void {
  if (op.kind === 'add') {
    if (tiles.some((tile) => tile.id === op.tile.id)) throw new InvalidInput({ reason: 'tile id already exists' })
    tiles.splice(Math.min(op.index ?? tiles.length, tiles.length), 0, { ...op.tile, placedBy: actor })
    return
  }
  const index = tiles.findIndex((tile) => tile.id === op.id)
  const tile = tiles[index]
  if (tile === undefined) throw new NotFound({ what: 'home tile' })
  switch (op.kind) {
    case 'move':
      tiles.splice(index, 1)
      tiles.splice(Math.min(op.index, tiles.length), 0, tile)
      break
    case 'resize':
      tiles[index] = { ...tile, size: op.size }
      break
    case 'update':
      if (tile.kind !== 'note') throw new InvalidInput({ reason: 'only a note has editable content' })
      tiles[index] = { ...tile, title: op.title, markdown: op.markdown }
      break
    case 'remove':
      tiles.splice(index, 1)
      break
  }
}

/** An agent may only target the tiles it placed; shifting other tiles as part of order is harmless. */
export const ownerTargets = (layout: HomeLayout, ops: readonly HomeOperation[]): readonly string[] => [
  ...new Set(
    ops.flatMap((op) =>
      op.kind !== 'add' && layout.tiles.some((tile) => tile.id === op.id && tile.placedBy === 'owner') ? [op.id] : [],
    ),
  ),
]

export const touchedTiles = (ops: readonly HomeOperation[]): readonly string[] => [
  ...new Set(ops.map((op) => (op.kind === 'add' ? op.tile.id : op.id))),
]
