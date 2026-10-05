import type { Edge } from '@danfessler/trellis'
import type { ItemKey } from './workspace.ts'

/** A pane's narrowest and shortest: a split that would leave either half below these is refused. */
export const PANE_MIN = { width: 320, height: 240 } as const

/** A box on screen, in CSS pixels. */
export type Box = { readonly left: number; readonly top: number; readonly width: number; readonly height: number }

/** Where over a pane something is dropped: near one of its edges, or its middle. */
export type Zone = Edge | 'center'

/** Within this of a pane's edge (28% of its size, at most 96px) a drop splits it there. */
const band = (size: number) => Math.min(size * 0.28, 96)

/** The zone of `box` under the point, or `undefined` when the point is outside it. */
export function zoneOf(box: Box, x: number, y: number): Zone | undefined {
  const right = box.left + box.width
  const bottom = box.top + box.height
  if (x < box.left || x > right || y < box.top || y > bottom) return undefined
  const near = (
    [
      ['left', x - box.left, box.width],
      ['right', right - x, box.width],
      ['top', y - box.top, box.height],
      ['bottom', bottom - y, box.height],
    ] as const
  )
    .filter(([, distance, size]) => distance < band(size))
    .toSorted((one, other) => one[1] - other[1])[0]
  return near?.[0] ?? 'center'
}

/**
 * What dropping `item` on the pane showing `target` would do: split it at an edge, open the item in its place (or
 * trade places with it when the item is already open), or nothing. Dropping a pane on itself does nothing; a split is
 * refused when a half would be under `PANE_MIN`, except sideways where the strip scrolls to make room.
 */
export type DropPlan =
  | { readonly kind: 'split'; readonly target: ItemKey; readonly edge: Edge }
  | { readonly kind: 'into'; readonly target: ItemKey; readonly swap: boolean }
  | { readonly kind: 'refused' }

export function planDrop(input: {
  readonly item: ItemKey
  readonly target: ItemKey
  readonly zone: Zone
  readonly box: Box
  readonly open: boolean
  /** Whether sideways splits always fit because the panes scroll. */
  readonly scrolls: boolean
}): DropPlan {
  const { item, target, zone, box } = input
  if (item === target) return { kind: 'refused' }
  if (zone === 'center') return { kind: 'into', target, swap: input.open }
  const sideways = zone === 'left' || zone === 'right'
  const room = sideways ? input.scrolls || box.width / 2 >= PANE_MIN.width : box.height / 2 >= PANE_MIN.height
  return room ? { kind: 'split', target, edge: zone } : { kind: 'refused' }
}

/** The part of `box` a plan would fill: half at the edge it splits, all of it for a drop into the pane. */
export function previewBox(box: Box, plan: DropPlan): Box | undefined {
  if (plan.kind === 'refused') return undefined
  if (plan.kind === 'into') return box
  const halfWidth = box.width / 2
  const halfHeight = box.height / 2
  if (plan.edge === 'left') return { ...box, width: halfWidth }
  if (plan.edge === 'right') return { ...box, left: box.left + halfWidth, width: halfWidth }
  if (plan.edge === 'top') return { ...box, height: halfHeight }
  return { ...box, top: box.top + halfHeight, height: halfHeight }
}
