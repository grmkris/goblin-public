import { describe, expect, it } from 'vitest'
import { logLine, logsQuery, operationsOf } from '../src/logs.ts'
import { failureText, render } from '../src/render.ts'
import { statsLine, statsQuery } from '../src/stats.ts'

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

  it("shows a conversation's entries with an answer's thinking before its words", () => {
    const text = render('conversation', {
      conversation: '1',
      entries: [
        {
          id: 9,
          kind: 'pi.assistant',
          role: 'assistant',
          thinking: 'Plan the app.\nThen build it.',
          text: 'Done.',
          model: {
            provider: 'goblin-litellm',
            model: 'glm-5.3',
            stopReason: 'length',
            inputTokens: 10,
            outputTokens: 32_768,
            cacheReadTokens: 0,
          },
        },
      ],
    })
    expect(text.split('\n')).toEqual([
      '#9 assistant',
      '  ~ Plan the app.',
      '  ~ Then build it.',
      '  Done.',
      '  [glm-5.3 length]',
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

  it("renders flow steps and a message's details with what they relate to", () => {
    const step = { flow: 'move', via: 'app', actor: 'owner', chat: '12', operationId: 'owner:op-9', status: 'refused' }
    expect(render('flows', { since: 0, flows: [{ ...step, ms: 40, at: AT }] })).toBe(
      '2026-10-06 10:00:00  move                 refused   app/owner         chat 12  owner:op-9  40ms',
    )
    expect(render('flows', { since: 0, flows: [] })).toBe('No flows in that window.')
    const details = render('details', {
      events: [event('flow', 'blocked', {})],
      coverage: { complete: true, gaps: [] },
      related: [{ operation: 'owner:op-8', kind: 'send', chat: '1', state: 'ok' }],
    })
    expect(details.split('\n')).toEqual([
      'No turn: the steps of this operation',
      '',
      `2026-10-06 10:00:00  flow             blocked        250ms    telegram-12`,
      '',
      'Related:',
      '  send  owner:op-8  chat 1  ok',
    ])
    expect(
      render('details', {
        turn: { ...turn, errors: 2 },
        events: [],
        coverage: { complete: true, gaps: [] },
        related: [],
      }),
    ).toContain('2 errors')
  })

  it('asks Analytics Engine for flow totals of a stage dataset, and refuses any other name', () => {
    const query = statsQuery('goblin-dev-flows', 90)
    expect(query).toContain('FROM "goblin-dev-flows"')
    expect(query).toContain("INTERVAL '90' MINUTE")
    expect(query).toContain('GROUP BY flow, status')
    expect(() => statsQuery('flows"; DROP', 60)).toThrow('not a dataset name')
    expect(statsLine({ flow: 'reply', status: 'ok', steps: 12.4, agents: 3, avg_ms: 41.6 })).toBe(
      'reply                ok            12 steps     3 agents  42ms avg',
    )
  })

  it("finds the operations goblin's own log lines name", () => {
    const line = (source: unknown) => ({ timestamp: AT, source })
    expect(
      operationsOf([
        line({ event: 'http.failure', operation: 'owner:op-3', ref: 'r1' }),
        line({ event: 'failure', 'goblin.operation': 'owner:op-4' }),
        line({ event: 'run', operation: 'owner:op-3' }),
        line('plain text'),
      ]),
    ).toEqual(['owner:op-3', 'owner:op-4'])
  })
})
