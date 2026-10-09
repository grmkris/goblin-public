import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { InspectDetails, InspectDetailsInput, InspectFlows, InspectFlowsInput, TurnSummary } from './inspect.ts'

const summary = {
  operationId: 'op-1',
  source: 'direct',
  status: 'ok',
  startedAt: 1,
  modelAttempts: 1,
  failedAttempts: 0,
  toolCalls: 0,
  failedToolCalls: 0,
  inputTokens: 10,
  outputTokens: 5,
}

describe('inspection contract', () => {
  it('reads a turn summary from a server without the error count', () => {
    expect(Schema.decodeUnknownSync(TurnSummary)(summary)).toEqual(summary)
    expect(Schema.decodeUnknownSync(TurnSummary)({ ...summary, errors: 2 }).errors).toBe(2)
  })
  it('asks for details by operation or by a chat entry', () => {
    const valid = Schema.is(InspectDetailsInput)
    expect(valid({ operation: 'op-1' })).toBe(true)
    expect(valid({ chat: '12', entry: 40 })).toBe(true)
    expect(valid({ chat: '12' })).toBe(false)
    expect(valid({})).toBe(false)
  })
  it('gives details without a turn, with related operations', () => {
    const details = {
      events: [],
      coverage: { complete: true, gaps: [] },
      related: [{ operation: 'op-0', kind: 'start', chat: '12', state: 'settled' }],
    }
    expect(Schema.decodeUnknownSync(InspectDetails)(details)).toEqual(details)
    expect(Schema.is(InspectDetails)({ ...details, turn: summary })).toBe(true)
  })
  it('pages flow events, filtered by chat or flow', () => {
    expect(Schema.is(InspectFlowsInput)({ chat: '12', flow: 'move', limit: 20 })).toBe(true)
    expect(Schema.is(InspectFlowsInput)({ flow: 'nonsense' })).toBe(false)
    const page = { since: 0, flows: [{ flow: 'move', via: 'app', actor: 'owner', status: 'refused', at: 5 }] }
    expect(Schema.decodeUnknownSync(InspectFlows)(page)).toEqual(page)
  })
})
