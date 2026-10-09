import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { FlowEvent, RunEventKind } from './telemetry.ts'

describe('flow events', () => {
  it('are a run event kind', () => {
    expect(Schema.is(RunEventKind)('flow')).toBe(true)
  })
  it('decode a content-free flow step', () => {
    const event = {
      flow: 'reply',
      via: 'app',
      actor: 'owner',
      chat: '12',
      parentChat: '1',
      topic: 2,
      operationId: 'op-1',
      count: 2,
      personaOrder: 'sequence',
      status: 'ok',
      ms: 41,
    }
    expect(Schema.decodeUnknownSync(FlowEvent)(event)).toEqual(event)
  })
  it('refuse open classifications and error text', () => {
    const base = { flow: 'send', via: 'app', actor: 'owner', status: 'error' }
    const valid = Schema.is(FlowEvent)
    expect(valid(base)).toBe(true)
    expect(valid({ ...base, flow: 'anything' })).toBe(false)
    expect(valid({ ...base, via: 'email' })).toBe(false)
    expect(valid({ ...base, actor: 'someone' })).toBe(false)
    expect(valid({ ...base, status: 'started' })).toBe(false)
    expect(valid({ ...base, personaOrder: 'random' })).toBe(false)
    expect(valid({ ...base, errorType: 'Internal' })).toBe(true)
    expect(valid({ ...base, errorType: 'Cannot read properties of undefined' })).toBe(false)
    expect(valid({ ...base, chat: 'not-a-chat' })).toBe(false)
    expect(valid({ ...base, count: -1 })).toBe(false)
  })
})
