import { describe, expect, it } from 'vitest'
import { canonicalArguments, EVENT_LIMITS, pendingFits } from '../../src/mcp/events/store.ts'

describe('Events storage bounds and selector identity', () => {
  it('canonicalizes nested selectors while preserving array order and null', () => {
    expect(canonicalArguments({ z: [null, { b: 2, a: 1 }], a: true })).toBe(
      canonicalArguments({ a: true, z: [null, { a: 1, b: 2 }] }),
    )
    expect(canonicalArguments([1, 2])).not.toBe(canonicalArguments([2, 1]))
    expect(() => canonicalArguments({ bad: undefined })).toThrow()
    expect(() => canonicalArguments({ bad: Infinity })).toThrow()
    expect(() => canonicalArguments({ text: 'x'.repeat(16_384) })).toThrow()
  })
  it('refuses receipt acceptance before either pending cap would be exceeded', () => {
    expect(pendingFits(9999, EVENT_LIMITS.pendingBytes - 1, 1)).toBe(true)
    expect(pendingFits(10_000, 0, 1)).toBe(false)
    expect(pendingFits(1, EVENT_LIMITS.pendingBytes, 1)).toBe(false)
  })
})
