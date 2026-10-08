import { describe, expect, it } from 'vitest'
import { viewportKeyboardInset } from '../src/lib/keyboard.ts'

describe('visual viewport keyboard space', () => {
  it('counts the keyboard and subtracts visual viewport panning', () => {
    expect(viewportKeyboardInset({ height: 524, offsetTop: 0, scale: 1 }, 844, true)).toBe(320)
    expect(viewportKeyboardInset({ height: 524, offsetTop: 60, scale: 1 }, 844, true)).toBe(260)
  })

  it('ignores pinch zoom, unfocused changes and unavailable viewport information', () => {
    expect(viewportKeyboardInset({ height: 422, offsetTop: 0, scale: 2 }, 844, true)).toBe(0)
    expect(viewportKeyboardInset({ height: 524, offsetTop: 0, scale: 1 }, 844, false)).toBe(0)
    expect(viewportKeyboardInset(null, 844, true)).toBe(0)
  })

  it('does not add a second inset on a browser that already resized the layout', () => {
    expect(viewportKeyboardInset({ height: 524, offsetTop: 0, scale: 1 }, 524, true)).toBe(0)
    expect(viewportKeyboardInset({ height: 844, offsetTop: 0, scale: 1 }, 800, true)).toBe(0)
  })
})
