import { describe, expect, it } from 'vitest'
import {
  atRest,
  type Motion,
  nearestCorner,
  nearestSnap,
  project,
  releaseVelocity,
  rubberband,
  type Spring,
  SPRINGS,
  stepSpring,
} from '../src/lib/spring.ts'

/** Run a spring at 60 fps until it rests (or give up after two seconds); returns the path it took. */
function settle(start: Motion, target: number, spring: Spring = SPRINGS.place): number[] {
  const path: number[] = []
  let motion = start
  for (let frame = 0; frame < 120 && !atRest(motion, target); frame += 1) {
    motion = stepSpring(motion, target, spring, 1 / 60)
    path.push(motion.value)
  }
  return path
}

describe('springs for the App stage', () => {
  it('settles a critically damped spring without overshoot, in about its response time', () => {
    const path = settle({ value: 0, velocity: 0 }, 100)
    expect(Math.max(...path)).toBeLessThanOrEqual(100.5)
    expect(path.length).toBeLessThan(60)
    expect(path.at(-1)).toBeCloseTo(100, 0)
  })
  it('lets a momentum spring overshoot, and keeps the release velocity at the seam', () => {
    const path = settle({ value: 0, velocity: 3000 }, 100, SPRINGS.momentum)
    expect(Math.max(...path)).toBeGreaterThan(100.5)
    expect(stepSpring({ value: 0, velocity: 3000 }, 0, SPRINGS.momentum, 1 / 240).value).toBeGreaterThan(10)
  })
  it('stays stable across a long frame', () => {
    const next = stepSpring({ value: 0, velocity: 0 }, 100, SPRINGS.sheet, 1)
    expect(Number.isFinite(next.value)).toBe(true)
    expect(Math.abs(next.value)).toBeLessThan(200)
  })
})

describe('gesture geometry', () => {
  it('projects a release forward like scroll deceleration', () => {
    expect(project(0)).toBe(0)
    expect(project(1000)).toBeCloseTo(499, 0)
    expect(project(-1000)).toBeCloseTo(-499, 0)
  })
  it('resists past an edge, more the further it goes', () => {
    expect(rubberband(0, 400)).toBe(0)
    expect(rubberband(100, 400)).toBeLessThan(100)
    expect(rubberband(400, 400) - rubberband(300, 400)).toBeLessThan(rubberband(100, 400))
    expect(rubberband(-100, 400)).toBeCloseTo(-rubberband(100, 400))
  })
  it('picks the snap and the corner nearest the projected end', () => {
    expect(nearestSnap(610, [420, 780])).toBe(780)
    expect(nearestSnap(590, [420, 780])).toBe(420)
    const corners = [
      { x: 16, y: 72 },
      { x: 1064, y: 72 },
      { x: 16, y: 640 },
      { x: 1064, y: 640 },
    ] as const
    expect(nearestCorner({ x: 900, y: 500 }, corners)).toEqual({ x: 1064, y: 640 })
  })
  it('measures release velocity over the last 100ms only', () => {
    const samples = [
      { x: 0, y: 0, time: 0 },
      { x: 0, y: 0, time: 500 },
      { x: 50, y: 10, time: 550 },
      { x: 100, y: 20, time: 600 },
    ]
    expect(releaseVelocity(samples)).toEqual({ x: 1000, y: 200 })
    expect(releaseVelocity([])).toEqual({ x: 0, y: 0 })
  })
})
