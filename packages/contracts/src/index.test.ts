import { describe, expect, it } from 'vitest'
import { isJsonObject } from './index.ts'

describe('contracts', () => {
  it('recognizes object-shaped boundary values', () => {
    expect(isJsonObject({ ok: true })).toBe(true)
    expect(isJsonObject(['not', 'an', 'object'])).toBe(false)
  })
})
