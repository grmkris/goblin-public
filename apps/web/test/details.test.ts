import type { InspectDetails } from '@goblin/contracts/inspect'
import { describe, expect, it } from 'vitest'
import { detailSteps, detailSummary, relatedText } from '../src/lib/details.ts'
import { durationText } from '../src/lib/format.ts'

const DETAILS: InspectDetails = {
  turn: {
    operationId: 'op-1',
    conversationId: '7',
    source: 'app',
    status: 'error',
    reason: 'tool_failed',
    startedAt: 1_000,
    endedAt: 5_200,
    modelAttempts: 2,
    failedAttempts: 1,
    toolCalls: 1,
    failedToolCalls: 1,
    inputTokens: 1200,
    outputTokens: 80,
    errors: 1,
  },
  events: [
    {
      id: 'e3',
      kind: 'tool.call',
      status: 'error',
      startedAt: 3_000,
      endedAt: 3_400,
      attributes: { 'gen_ai.tool.name': 'mcp_call', 'error.type': 'UpstreamMcp' },
    },
    {
      id: 'e2',
      kind: 'model.attempt',
      status: 'ok',
      startedAt: 1_100,
      endedAt: 2_900,
      attributes: {
        'gen_ai.response.model': 'sonnet',
        'gen_ai.usage.input_tokens': 600,
        'gen_ai.usage.output_tokens': 40,
      },
    },
    {
      id: 'e4',
      kind: 'flow',
      status: 'ok',
      startedAt: 5_000,
      attributes: { 'goblin.flow': 'reply', 'goblin.flow.via': 'app' },
    },
  ],
  coverage: { complete: true, gaps: [] },
  related: [{ operation: 'op-2', kind: 'start', chat: '9', state: 'settled' }],
}

describe("a message's details, in the owner's words", () => {
  it('lists the steps in the order they ran, each with what it touched and how it ended', () => {
    expect(detailSteps(DETAILS)).toEqual([
      { id: 'e2', label: 'Model sonnet', detail: '600 in · 40 out tokens', status: 'ok', ms: 1800 },
      { id: 'e3', label: 'Tool mcp_call', detail: 'UpstreamMcp', status: 'error', ms: 400 },
      { id: 'e4', label: 'Flow reply', detail: 'app', status: 'ok', ms: undefined },
    ])
  })
  it('sums the operation up, and says when no model ran for it', () => {
    expect(detailSummary(DETAILS)).toEqual([
      'From app · error (tool_failed) · 4.2 s',
      '2 model attempts (1 failed) · 1 tool call (1 failed)',
      '1200 in · 80 out tokens · 1 error',
    ])
    expect(detailSummary({ ...DETAILS, turn: undefined })).toEqual(['A written note: no model ran for it.'])
  })
  it('reads related operations and durations plainly', () => {
    expect(relatedText({ operation: 'op-2', kind: 'start', state: 'settled' })).toBe('start · settled')
    expect(durationText(250)).toBe('250 ms')
    expect(durationText(90_000)).toBe('1.5 min')
  })
})
