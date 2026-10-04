// Springs and gesture geometry for the App stage, after Apple's "Designing Fluid Interfaces": a spring is a damping
// ratio and a response (seconds), it animates from wherever the value is now and keeps its velocity when the target
// moves, so every transition can be grabbed and redirected. Pure, so it is tested without a browser.

/** A spring as Apple describes it: `damping` 1 settles without overshoot, below 1 bounces; `response` is its pace. */
export type Spring = { readonly response: number; readonly damping: number }

/** House springs: `place` moves things without bounce; `momentum` follows a throw, so it may overshoot a little. */
export const SPRINGS = {
  place: { response: 0.4, damping: 1 },
  momentum: { response: 0.4, damping: 0.8 },
  sheet: { response: 0.3, damping: 0.8 },
} as const satisfies Record<string, Spring>

export type Motion = { readonly value: number; readonly velocity: number }

/** Smaller steps than any frame, so a stiff spring stays stable at 30 fps. */
const MAX_STEP = 1 / 240

/** Advance `motion` towards `target` by `seconds`, as a unit mass on a damped spring (semi-implicit Euler). */
export function stepSpring(motion: Motion, target: number, spring: Spring, seconds: number): Motion {
  const stiffness = ((2 * Math.PI) / spring.response) ** 2
  const friction = (4 * Math.PI * spring.damping) / spring.response
  let { value, velocity } = motion
  let left = Math.min(seconds, 0.1)
  while (left > 0) {
    const dt = Math.min(left, MAX_STEP)
    velocity += (-stiffness * (value - target) - friction * velocity) * dt
    value += velocity * dt
    left -= dt
  }
  return { value, velocity }
}

/** Close enough to the target and slow enough that the next frame would not visibly move it. */
export function atRest(motion: Motion, target: number): boolean {
  return Math.abs(motion.value - target) < 0.5 && Math.abs(motion.velocity) < 5
}

/** Where a release at `velocity` (px/s) would coast to, as scroll views decelerate (Apple's projection). */
export function project(velocity: number, rate = 0.998): number {
  return ((velocity / 1000) * rate) / (1 - rate)
}

/** Past an edge, follow the pointer less and less: resistance instead of a wall. */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  if (dimension <= 0) return 0
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot))
}

/** The snap point nearest `value`. */
export function nearestSnap(value: number, snaps: readonly [number, ...number[]]): number {
  return snaps.reduce((best, snap) => (Math.abs(snap - value) < Math.abs(best - value) ? snap : best), snaps[0])
}

export type Point = { readonly x: number; readonly y: number }

/** The corner nearest `point`, measured between top-left positions. */
export function nearestCorner(point: Point, corners: readonly [Point, ...Point[]]): Point {
  const distance = (corner: Point) => Math.hypot(corner.x - point.x, corner.y - point.y)
  return corners.reduce((best, corner) => (distance(corner) < distance(best) ? corner : best), corners[0])
}

/** Release velocity (px/s) from the last pointer samples, ignoring samples older than 100ms. */
export function releaseVelocity(samples: readonly (Point & { readonly time: number })[]): Point {
  const last = samples.at(-1)
  if (last === undefined) return { x: 0, y: 0 }
  const first = samples.find((sample) => last.time - sample.time <= 100) ?? last
  const seconds = (last.time - first.time) / 1000
  if (seconds <= 0) return { x: 0, y: 0 }
  return { x: (last.x - first.x) / seconds, y: (last.y - first.y) / seconds }
}
