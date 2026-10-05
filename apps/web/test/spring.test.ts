import { describe, expect, it } from 'vitest'
import { atRest, type Motion, PLACE, type Spring, stepSpring } from '../src/lib/spring.ts'

/** Run a spring at 60 fps until it rests (or give up after two seconds); returns the path it took. */
function settle(start: Motion, target: number, spring: Spring = PLACE): number[] {
  const path: number[] = []
  let motion = start
  for (let frame = 0; frame < 120 && !atRest(motion, target); frame += 1) {
    motion = stepSpring(motion, target, spring, 1 / 60)
    path.push(motion.value)
  }
  return path
}

describe('the App stage spring', () => {
  it('settles without overshoot, in about its response time', () => {
    const path = settle({ value: 0, velocity: 0 }, 100)
    expect(Math.max(...path)).toBeLessThanOrEqual(100.5)
    expect(path.length).toBeLessThan(60)
    expect(path.at(-1)).toBeCloseTo(100, 0)
  })
  it('keeps the velocity it had when the target moves mid-flight', () => {
    const moving = stepSpring({ value: 0, velocity: 0 }, 100, PLACE, 0.1)
    const redirected = stepSpring(moving, 0, PLACE, 1 / 240)
    expect(redirected.velocity).toBeGreaterThan(0)
    expect(settle(moving, 0).at(-1)).toBeCloseTo(0, 0)
  })
  it('stays stable across a long frame', () => {
    const next = stepSpring({ value: 0, velocity: 0 }, 100, PLACE, 1)
    expect(Number.isFinite(next.value)).toBe(true)
    expect(Math.abs(next.value)).toBeLessThan(200)
  })
})
