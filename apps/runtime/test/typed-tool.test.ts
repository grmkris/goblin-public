import type { ToolRegistration } from '@earendil-works/pi-durable'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { type TypedTool, jsonSchemaOf, toolSignature, typedTool } from '../src/pi/typed-tool.ts'

const Place = Schema.Struct({ name: Schema.String, lat: Schema.Number }).annotate({ identifier: 'Place' })
const Trip = Schema.Struct({ from: Place, to: Place, days: Schema.optional(Schema.Int) })
const Plan = Schema.Struct({ legs: Schema.Number, note: Schema.String })

// SAFETY: these tools read nothing of the API or context.
const call = (tool: ToolRegistration, args: unknown) => tool.execute(args, {} as never, {} as never)

const trip: TypedTool<typeof Trip.Type, typeof Plan.Type> = {
  name: 'trip_plan',
  description: 'Plan a trip.',
  input: Trip,
  output: Plan,
  replay: 'safe',
  execute: async ({ from, to, days }) => {
    if (from.name === to.name) throw new Error('nowhere to go')
    return { legs: days ?? 1, note: `${from.name} to ${to.name}` }
  },
  details: (plan) => ({ kind: 'trip', legs: plan.legs }),
  terminate: (plan) => plan.legs > 5,
}
const trips = typedTool(trip)

describe('typed tools (unit, ADR 0027)', () => {
  it('offer the input as one JSON Schema without references, and list their signatures', () => {
    const schema = jsonSchemaOf(Trip)
    expect(JSON.stringify(schema)).not.toContain('$ref')
    expect(schema).toMatchObject({
      type: 'object',
      required: ['from', 'to'],
      properties: { from: { type: 'object', properties: { name: { type: 'string' } } } },
    })
    expect(trips.parameters).toEqual(schema)
    expect(toolSignature(trip)).toMatchObject({
      description: 'Plan a trip.',
      outputSchema: { type: 'object', required: ['legs', 'note'] },
    })
  })

  it('offer an empty input as an object with no fields, as providers require', () => {
    const none = typedTool({
      name: 'nothing_list',
      description: 'List nothing.',
      input: Schema.Struct({}),
      output: Schema.Array(Schema.String),
      replay: 'safe',
      execute: async () => [],
    })
    expect(none.parameters).toEqual({ type: 'object', properties: {} })
  })

  it('decode the arguments, and return the output as JSON text and structuredContent beside the web fields', async () => {
    const result = await call(trips, { from: { name: 'Tallinn', lat: 59 }, to: { name: 'Riga', lat: 57 }, days: 2 })
    expect(result).toEqual({
      content: [{ type: 'text', text: '{"legs":2,"note":"Tallinn to Riga"}' }],
      details: { kind: 'trip', legs: 2, structuredContent: { legs: 2, note: 'Tallinn to Riga' } },
    })
    // The offered schema lets an optional field be null (its JSON form); it decodes as absent.
    const unset = await call(trips, { from: { name: 'A', lat: 0 }, to: { name: 'B', lat: 0 }, days: null })
    expect(unset.details).toMatchObject({ structuredContent: { legs: 1 } })
    const long = await call(trips, { from: { name: 'A', lat: 0 }, to: { name: 'B', lat: 0 }, days: 9 })
    expect(long.control).toEqual({ terminate: true })
  })

  it('turn bad arguments and failures into error results the model can act on', async () => {
    const bad = await call(trips, { from: { name: 'Tallinn' }, to: 'Riga' })
    expect(bad.isError).toBe(true)
    expect(JSON.stringify(bad.content)).toContain("The arguments do not match trip_plan's input")
    expect(bad.diagnostics).toMatchObject([{ severity: 'error', code: 'invalid_arguments' }])
    const thrown = await call(trips, { from: { name: 'A', lat: 0 }, to: { name: 'A', lat: 0 } })
    expect(thrown).toEqual({
      content: [{ type: 'text', text: 'nowhere to go' }],
      isError: true,
      diagnostics: [{ severity: 'error', code: 'Error', message: 'nowhere to go' }],
    })
  })
})
