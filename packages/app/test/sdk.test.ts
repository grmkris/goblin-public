import { describe, expect, it } from 'vitest'
import { defineApp, s } from '../src/sdk.ts'

describe('schema builders', () => {
  it('make objects strict, with optional properties left out of required', () => {
    expect(s.object({ title: s.string({ min: 1, max: 200 }), done: s.optional(s.boolean()) })).toEqual({
      type: 'object',
      properties: { title: { type: 'string', minLength: 1, maxLength: 200 }, done: { type: 'boolean' } },
      required: ['title'],
      additionalProperties: false,
    })
  })
  it('make whole numbers, lists, maps, choices and nullables', () => {
    expect(s.number({ int: true, min: 0 })).toEqual({ type: 'integer', minimum: 0 })
    expect(s.array(s.string(), { max: 10 })).toEqual({ type: 'array', items: { type: 'string' }, maxItems: 10 })
    expect(s.record(s.number())).toEqual({ type: 'object', additionalProperties: { type: 'number' } })
    expect(s.enum(['a', 'b'])).toEqual({ type: 'string', enum: ['a', 'b'] })
    expect(s.nullable(s.string())).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] })
  })
  it('are frozen, and defineApp returns the definition unchanged', () => {
    expect(Object.isFrozen(s.string())).toBe(true)
    const definition = { name: 'x' }
    expect(defineApp(definition)).toBe(definition)
  })
})
