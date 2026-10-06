import { RunAttribute } from '@goblin/contracts/telemetry'
import * as Effect from 'effect/Effect'
import { expect } from 'vitest'

/** The run ledger a real turn leaves in the agent's SQLite, and the restart sweep (ADR 0024). */
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
      left: 'interrupted',
      recovery: [{ [RunAttribute.recovery]: 'restarted', [RunAttribute.interrupted]: 1 }],
    })
  })
}
