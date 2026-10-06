import { describe, expect, it } from 'vitest'
import { logLine, logsQuery } from '../src/logs.ts'
import { failureText, render } from '../src/render.ts'

const AT = Date.UTC(2026, 9, 6, 10, 0, 0)
const turn = {
  operationId: 'telegram-12',
  conversationId: '1',
  source: 'telegram',
  status: 'error',
  reason: 'model_error',
  startedAt: AT,
  endedAt: AT + 900,
  modelAttempts: 2,
  failedAttempts: 1,
  toolCalls: 1,
  failedToolCalls: 1,
  inputTokens: 120,
  outputTokens: 30,
}
const event = (kind: string, status: string, attributes: Record<string, string | number>) => ({
  id: `${kind}-${status}`,
  kind,
  status,
  operationId: 'telegram-12',
  startedAt: AT,
  endedAt: AT + 250,
  attributes,
})

describe('goblin output (unit)', () => {
  it('shows a turn as its summary, Pi settlement, events and gaps', () => {
    const text = render('turn', {
      turn,
      submission: { status: 'unanswered', reason: 'model_error' },
      events: [
        event('model.attempt', 'error', { 'gen_ai.request.model': 'gpt-test', 'goblin.error': 'rate limited' }),
        event('tool.call', 'blocked', { 'gen_ai.tool.name': 'mcp_call', 'goblin.blocked_reason': 'grant' }),
      ],
      coverage: { complete: false, gaps: ['Some events have not ended.'] },
    })
    expect(text.split('\n')).toEqual([
      '2026-10-06 10:00:00  error        telegram         2 calls (1 failed)  1 tools (1 failed)  120/30 tok  telegram-12  model_error',
      'Pi: unanswered (model_error)',
      '',
      '2026-10-06 10:00:00  model.attempt    error          250ms  gpt-test  rate limited',
      expect.stringMatching(/^2026-10-06 10:00:00 {2}tool\.call {8}blocked {8}250ms {2}mcp_call/u),
      '',
      '! Some events have not ended.',
    ])
  })

  it("says a tool's failure in a line", () => {
    expect(failureText('{"_tag":"NotFound","what":"turn"}')).toBe('NotFound: what=turn')
    expect(failureText('plain words')).toBe('plain words')
  })

  it('falls back to JSON for shapes it does not know', () => {
    expect(render('turns', { unexpected: true })).toBe('{\n  "unexpected": true\n}')
    expect(render('turns', { turns: [] })).toBe('No turns in that window.')
  })

  it("asks Workers Logs for one Worker's lines that mention an id", () => {
    expect(logsQuery({ worker: 'goblin-dev', needle: 'telegram-12', from: 1, to: 2 })).toMatchObject({
      view: 'events',
      timeframe: { from: 1, to: 2 },
      parameters: {
        filters: [{ key: '$metadata.service', operation: 'eq', type: 'string', value: 'goblin-dev' }],
        needle: { value: 'telegram-12' },
      },
    })
    expect(
      logLine({
        timestamp: AT,
        $metadata: { level: 'info', requestId: 'r1' },
        source: { event: 'run', kind: 'tool.call' },
      }),
    ).toBe('2026-10-06T10:00:00.000Z  info  r1  {"event":"run","kind":"tool.call"}')
  })
})
