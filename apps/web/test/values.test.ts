import { describe, expect, it } from 'vitest'
import { identifier, record, records, text } from '../src/lib/values.ts'

describe('the value readers', () => {
  it('read objects, text parts and ids without throwing', () => {
    expect(record({ a: 1 })).toEqual({ a: 1 })
    expect(record([1])).toBeUndefined()
    expect(records([{ a: 1 }, 2, null, { b: 2 }])).toEqual([{ a: 1 }, { b: 2 }])
    expect(records('x')).toEqual([])
    expect(text('plain')).toBe('plain')
    expect(text([{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }])).toBe('one\ntwo')
    expect(identifier(7)).toBe('7')
    expect(identifier({})).toBe('')
  })
})
