// Springs for the App stage, after Apple's "Designing Fluid Interfaces": a spring is a damping ratio and a response
// (seconds), it animates from wherever the value is now and keeps its velocity when the target moves, so an App moving
// between its place in the transcript and its page can be redirected mid-flight. Pure, so it is tested without a browser.

/** A spring as Apple describes it: `damping` 1 settles without overshoot, below 1 bounces; `response` is its pace. */
export type Spring = { readonly response: number; readonly damping: number }

/** The house spring: it moves things without bounce. */
export const PLACE: Spring = { response: 0.4, damping: 1 }

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
