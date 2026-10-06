import { describe, expect, it } from 'vitest'
import { nearestHomeSlot, projectHomeDrag } from '../src/lib/home-drag.ts'

describe('Home drag release', () => {
  it('projects pointer velocity with the configured decay and chooses a bounded visual slot', () => {
    const slots = [
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 112, y: 0, width: 100, height: 100 },
    ]
    expect(nearestHomeSlot({ x: 50, y: 50 }, slots)).toBe(0)
    expect(nearestHomeSlot({ x: projectHomeDrag(50, 300), y: 50 }, slots)).toBe(1)
    expect(nearestHomeSlot({ x: projectHomeDrag(162, -300), y: 50 }, slots)).toBe(0)
    expect(projectHomeDrag(5, 0)).toBe(5)
    expect(nearestHomeSlot({ x: 10000, y: 50 }, slots)).toBe(1)
  })
})
