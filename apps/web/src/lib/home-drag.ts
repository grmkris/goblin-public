import type { Rect } from './app-stage.ts'

/** UIKit's 0.998 per millisecond decay, projected to rest, in pixels for a pixels/second velocity. */
export const projectHomeDrag = (position: number, velocity: number): number =>
  position + velocity / (-1000 * Math.log(0.998))

/** Ordered slots stay device-independent; the nearest visual slot determines the shared list index. */
export function nearestHomeSlot(point: { readonly x: number; readonly y: number }, slots: readonly Rect[]): number {
  let index = 0
  let distance = Infinity
  for (const [candidate, rect] of slots.entries()) {
    const next = Math.hypot(point.x - rect.x - rect.width / 2, point.y - rect.y - rect.height / 2)
    if (next < distance) {
      index = candidate
      distance = next
    }
  }
  return index
}
