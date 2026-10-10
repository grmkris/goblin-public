import { RunAttribute, type RunEvent } from '@goblin/contracts/telemetry'
import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppError } from '../src/http/errors.ts'
import type { AgentServices } from '../src/layers/index.ts'
import { diagnoseExtension } from '../src/pi/diagnose.ts'
import { inspectionFixture } from './inspection-fixture.ts'
import { executeTool } from './pi-tool.ts'

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

/** `diagnose` over a real ledger, its programs run with only the `Inspection` service it reads. */
const fixture = () => {
  const { ledger, layer, close } = inspectionFixture()
  closes.push(close)
  const run = <A>(program: Effect.Effect<A, AppError, AgentServices>): Promise<A> =>
    // SAFETY: diagnose's programs require only `Inspection`, which `layer` provides.
    Effect.runPromise(Effect.provide(program, layer) as Effect.Effect<A, AppError>)
  const tool = diagnoseExtension(run).tools?.find((candidate) => candidate.name === 'diagnose')
  const diagnose = async (input: Record<string, unknown>): Promise<unknown> => {
    if (tool === undefined) throw new Error('diagnose is not registered')
    const result = await executeTool(tool, input)
    const [block] = result?.content ?? []
    return block?.type === 'text' ? JSON.parse(block.text) : undefined
  }
  return { ledger, diagnose }
}

const at = Date.now() - 60_000
const turn: RunEvent = {
  id: 'turn:op-1',
  kind: 'turn.submitted',
  status: 'error',
  operationId: 'op-1',
  startedAt: at,
  endedAt: at + 500,
  attributes: { [RunAttribute.source]: 'telegram', [RunAttribute.reason]: 'faulted' },
}
const call: RunEvent = {
  id: 'tool:t1',
  kind: 'tool.call',
  status: 'blocked',
  operationId: 'op-1',
  taskId: 't1',
  startedAt: at + 100,
  endedAt: at + 200,
  attributes: { [RunAttribute.toolName]: 'mcp_call', [RunAttribute.errorType]: 'GrantDenied' },
}

const relayFailed: RunEvent = {
  id: 'task:t2',
  kind: 'error',
  status: 'error',
  operationId: 'op-1',
  startedAt: at + 300,
  endedAt: at + 300,
  attributes: { [RunAttribute.taskKind]: 'subagent.relay' },
}

describe('diagnose (unit, ADR 0024)', () => {
  it("reads the recent problems and turns through the agent's inspection", async () => {
    const { ledger, diagnose } = fixture()
    ledger.ended(turn)
    ledger.ended(call)
    ledger.ended(relayFailed)
    expect(await diagnose({ all: true })).toMatchObject({
      trusted: false,
      problems: [
        { kind: 'error', status: 'error', [RunAttribute.taskKind]: 'subagent.relay' },
        { kind: 'tool.call', status: 'blocked', ms: 100, [RunAttribute.errorType]: 'GrantDenied' },
        { kind: 'turn.submitted', status: 'error', ms: 500, [RunAttribute.source]: 'telegram' },
      ],
      turns: [
        { operationId: 'op-1', status: 'error', source: 'telegram', toolCalls: 1, failedToolCalls: 1, errors: 1 },
      ],
    })
  })

  it("gives one turn's events in brief, and says when there is no such turn", async () => {
    const { ledger, diagnose } = fixture()
    ledger.ended(turn)
    ledger.ended(call)
    expect(await diagnose({ operationId: 'op-1' })).toMatchObject({
      trusted: false,
      turn: { operationId: 'op-1', reason: 'faulted' },
      events: [{ kind: 'turn.submitted' }, { kind: 'tool.call', [RunAttribute.toolName]: 'mcp_call' }],
      coverage: { complete: false },
    })
    expect(await diagnose({ operationId: 'missing' })).toEqual({
      found: false,
      note: 'No turn with that operation id in the last 30 days.',
    })
  })
})
