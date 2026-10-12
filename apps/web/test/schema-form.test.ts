import { describe, expect, it } from 'vitest'
import { formFields, formInputs, formValue } from '../src/lib/schema-form.ts'

/** Sidequest's inbox stream as it might describe its filters: an agent to watch, a kind, a minimum and some tags. */
const INBOX = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['quote', 'pick', 'payout'], description: 'Which messages.' },
    agentId: { type: 'string', title: 'Agent', description: 'x'.repeat(300) },
    minimum: { type: 'integer' },
    urgent: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['agentId'],
}

describe('a form from an event input schema (ADR 0041)', () => {
  it('draws a field for each flat property, required ones first, with the server words bounded', () => {
    const fields = formFields(INBOX)
    expect(fields?.map((field) => [field.name, field.kind, field.required])).toEqual([
      ['agentId', 'text', true],
      ['kind', 'choice', false],
      ['minimum', 'number', false],
      ['urgent', 'boolean', false],
      ['tags', 'list', false],
    ])
    expect(fields?.[0]).toMatchObject({ title: 'Agent' })
    expect(fields?.[0]?.description).toHaveLength(200)
    expect(formFields({ type: 'object' })).toEqual([])
  })

  it('has no fields for what a flat form cannot hold: a nested object, a list of objects, too many properties', () => {
    expect(formFields({ type: 'object', properties: { where: { type: 'object' } } })).toBeUndefined()
    expect(formFields({ properties: { items: { type: 'array', items: { type: 'object' } } } })).toBeUndefined()
    const many = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`p${String(index)}`, { type: 'string' }]))
    expect(formFields({ type: 'object', properties: many })).toBeUndefined()
    expect(formFields('not a schema')).toBeUndefined()
  })

  it('makes exact filters of what was filled in, each as its type, and says what to fix', () => {
    const fields = formFields(INBOX) ?? []
    const typed = { agentId: ' w-1 ', kind: 'pick', minimum: '40', urgent: 'false', tags: 'docs, ,writing' }
    expect(formValue(fields, typed)).toEqual({
      value: { agentId: 'w-1', kind: 'pick', minimum: 40, urgent: false, tags: ['docs', 'writing'] },
    })
    expect(formValue(fields, { agentId: 'w-1' })).toEqual({ value: { agentId: 'w-1' } })
    expect(formValue(fields, { agentId: 'w-1', minimum: '4.5' })).toEqual({
      problem: 'minimum must be a whole number.',
    })
    expect(formValue(fields, {})).toEqual({ problem: 'Agent is needed: the server asks for it.' })
  })

  it('shows existing filters in their fields, and none that a field cannot show', () => {
    const fields = formFields(INBOX) ?? []
    expect(formInputs(fields, { agentId: 'w-1', urgent: true, tags: ['a', 'b'] })).toEqual({
      agentId: 'w-1',
      urgent: 'true',
      tags: 'a, b',
    })
    expect(formInputs(fields, { kind: 'other' })).toBeUndefined()
    expect(formInputs(fields, { unknown: 'x' })).toBeUndefined()
  })

  it('takes a nullable property as a plain optional field, with the server default as its hint', () => {
    const fields = formFields({
      type: 'object',
      properties: {
        botId: { type: ['string', 'null'], title: 'Bot', description: 'Which bot.' },
        chat: { anyOf: [{ type: 'string' }, { type: 'null' }], default: 'all' },
        limit: { type: 'integer', default: 20 },
      },
      required: ['botId'],
    })
    expect(
      fields?.map(({ name, kind, required, nullable, fallback }) => ({ name, kind, required, nullable, fallback })),
    ).toEqual([
      { name: 'botId', kind: 'text', required: true, nullable: true, fallback: undefined },
      { name: 'chat', kind: 'text', required: false, nullable: true, fallback: 'all' },
      { name: 'limit', kind: 'number', required: false, nullable: false, fallback: '20' },
    ])
    // Left empty, a required field that takes null sends null; a filled one sends its value.
    expect(formValue(fields ?? [], {})).toEqual({ value: { botId: null } })
    expect(formValue(fields ?? [], { botId: 'b-1' })).toEqual({ value: { botId: 'b-1' } })
    expect(formInputs(fields ?? [], { botId: null })).toEqual({ botId: '' })
  })

  it('still sends a union of types to JSON', () => {
    expect(formFields({ type: 'object', properties: { id: { type: ['string', 'number'] } } })).toBeUndefined()
    expect(
      formFields({ type: 'object', properties: { id: { anyOf: [{ type: 'string' }, { type: 'number' }] } } }),
    ).toBeUndefined()
  })
})
