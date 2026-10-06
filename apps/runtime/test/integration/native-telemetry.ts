import { RunAttribute } from '@goblin/contracts/telemetry'
import * as Effect from 'effect/Effect'
import { expect } from 'vitest'

/** The run ledger a real turn leaves in the agent's SQLite, the agent's `/inspect` route over it, and the restart sweep (ADR 0024). */
export function telemetryCase(url: string) {
  return Effect.promise(async () => {
    const response = await fetch(`${url.replace(/\/+$/u, '')}/telemetry?name=telemetry-${Date.now()}`)
    const text = await response.text()
    expect(response.status, text).toBe(200)
    const result: unknown = JSON.parse(text)
    expect(result).toMatchObject({
      rows: [
        { kind: 'turn.submitted', status: 'ok', attributes: { [RunAttribute.source]: 'direct' } },
        { kind: 'model.attempt', status: 'ok', attributes: { [RunAttribute.finishReason]: 'toolUse' } },
        {
          kind: 'tool.call',
          status: 'ok',
          attributes: { [RunAttribute.toolName]: 'subagent', [RunAttribute.toolFamily]: 'subagent' },
        },
        { kind: 'model.attempt', status: 'ok', attributes: { [RunAttribute.finishReason]: 'stop' } },
      ],
      inspected: {
        turn: {
          ok: true,
          value: {
            turn: {
              operationId: 'telemetry-turn',
              source: 'direct',
              status: 'ok',
              modelAttempts: 2,
              failedAttempts: 0,
              toolCalls: 1,
              failedToolCalls: 0,
            },
            submission: { status: 'done' },
            events: [
              { kind: 'turn.submitted' },
              { kind: 'model.attempt' },
              { kind: 'tool.call' },
              { kind: 'model.attempt' },
            ],
            coverage: { complete: true, gaps: [] },
          },
        },
        turns: { ok: true, value: { turns: [{ operationId: 'telemetry-turn', status: 'ok' }] } },
        conversation: {
          ok: true,
          value: {
            entries: expect.arrayContaining([
              expect.objectContaining({ role: 'user', text: expect.stringContaining('call subagent') }),
              expect.objectContaining({
                role: 'assistant',
                toolCalls: [expect.objectContaining({ name: 'subagent' })],
              }),
              expect.objectContaining({ tool: expect.objectContaining({ name: 'subagent', isError: false }) }),
            ]),
          },
        },
        missing: { ok: false, error: { _tag: 'NotFound', what: 'turn' } },
        invalid: { ok: false, error: { _tag: 'InvalidInput' } },
      },
      diagnosed: expect.stringMatching(/done: .*trusted.*telemetry-turn.*tool\.call/u),
      left: 'interrupted',
      recovery: [{ [RunAttribute.recovery]: 'restarted', [RunAttribute.interrupted]: 1 }],
      problems: {
        ok: true,
        value: {
          problems: expect.arrayContaining([expect.objectContaining({ id: 'probe:left', status: 'interrupted' })]),
        },
      },
    })
  })
}
