import { describe, expect, it } from 'vitest'
import { internalRefused } from '../../scripts/smoke-edge.ts'

describe('internalRefused', () => {
  it('accepts the runtime envelope 404 and the web Worker not-found page', () => {
    expect(internalRefused(404, JSON.stringify({ error: { code: 'not_found', message: 'No such route.' } }))).toBe(true)
    expect(internalRefused(404, '<!doctype html><title>Not found</title>')).toBe(true)
  })

  it('refuses anything that is not a 404, or a 404 envelope of another kind', () => {
    expect(internalRefused(200, JSON.stringify({ messages: [] }))).toBe(false)
    expect(internalRefused(402, JSON.stringify({ error: { code: 'subscription_required' } }))).toBe(false)
    expect(internalRefused(404, JSON.stringify({ error: { code: 'forbidden' } }))).toBe(false)
  })
})
