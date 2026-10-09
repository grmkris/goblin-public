import { RunAttribute } from '@goblin/contracts/telemetry'
import * as Effect from 'effect/Effect'
import { expect } from 'vitest'

/** A vitest matcher where an object property expects a value: vitest types matchers `any`, this one `unknown`. */
const like = (matcher: unknown): unknown => matcher

/** The run ledger a real turn leaves in the agent's SQLite, the agent's `/inspect` route over it, and the restart sweep (ADR 0024). */
export function telemetryCase(url: string) {
  return Effect.promise(async () => {
    const response = await fetch(`${url.replace(/\/+$/u, '')}/telemetry?name=telemetry-${Date.now()}`)
    const text = await response.text()
    expect(response.status, text).toBe(200)
    expect(text).not.toContain('PRIVATE_NATIVE_PAYLOAD')
    const result: unknown = JSON.parse(text)
    expect(result).toMatchObject({
      rows: [
        { kind: 'turn.submitted', status: 'ok', attributes: { [RunAttribute.source]: 'direct' } },
        { kind: 'model.attempt', status: 'ok', attributes: { [RunAttribute.finishReason]: 'toolUse' } },
        {
          kind: 'tool.call',
          status: 'ok',
          attributes: { [RunAttribute.toolName]: 'subagent_status', [RunAttribute.toolFamily]: 'subagent' },
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
            entries: like(
              expect.arrayContaining([
                expect.objectContaining({ role: 'user', text: like(expect.stringContaining('call subagent')) }),
                expect.objectContaining({
                  role: 'assistant',
                  toolCalls: [expect.objectContaining({ name: 'subagent_status' })],
                }),
                expect.objectContaining({
                  tool: like(expect.objectContaining({ name: 'subagent_status', isError: false })),
                }),
              ]),
            ),
          },
        },
        missing: { ok: false, error: { _tag: 'NotFound', what: 'turn' } },
        invalid: { ok: false, error: { _tag: 'InvalidInput' } },
      },
      details: {
        byOperation: {
          ok: true,
          value: {
            turn: { operationId: 'telemetry-turn', status: 'ok', toolCalls: 1 },
            submission: { status: 'done' },
            coverage: { complete: true, gaps: [] },
            related: [
              { operation: 'telemetry-thread', kind: 'start', chat: '1', state: 'ok' },
              { operation: 'persona:telemetry-turn:7', kind: 'persona_answer' },
            ],
          },
        },
        byEntry: { ok: true, value: { turn: { operationId: 'telemetry-turn' } } },
        thread: {
          ok: true,
          value: {
            events: [{ kind: 'flow', operationId: 'telemetry-thread' }],
            related: [{ operation: 'telemetry-turn', kind: 'operation' }],
          },
        },
      },
      diagnosed: like(expect.stringMatching(/done: .*trusted.*telemetry-turn.*tool\.call/u)),
      left: 'interrupted',
      recovery: [{ [RunAttribute.recovery]: 'restarted', [RunAttribute.interrupted]: 1 }],
      attention: {
        ok: true,
        value: {
          problems: [
            expect.objectContaining({
              id: 'filter:unresolved',
              attributes: like(expect.objectContaining({ [RunAttribute.error]: 'Model provider failed.' })),
            }),
          ],
        },
      },
      all: {
        ok: true,
        value: {
          problems: like(
            expect.arrayContaining([
              expect.objectContaining({ id: 'filter:aux-failure' }),
              expect.objectContaining({ id: 'filter:authorization' }),
              expect.objectContaining({ id: 'filter:failure' }),
              expect.objectContaining({ id: 'filter:cutoff' }),
              expect.objectContaining({ id: 'filter:empty' }),
              expect.objectContaining({ id: 'filter:gap' }),
            ]),
          ),
        },
      },
      incomplete: {
        ok: true,
        value: {
          problems: [
            expect.objectContaining({ id: 'filter:gap' }),
            expect.objectContaining({ id: 'filter:empty' }),
            expect.objectContaining({ id: 'filter:cutoff' }),
            expect.objectContaining({ id: 'filter:unresolved' }),
            expect.objectContaining({ id: 'filter:aux-failure' }),
          ],
        },
      },
      problems: {
        ok: true,
        value: {
          problems: like(
            expect.arrayContaining([expect.objectContaining({ id: 'probe:left', status: 'interrupted' })]),
          ),
        },
      },
      paged: {
        ok: true,
        value: {
          problems: [
            expect.objectContaining({ id: 'filter:gap' }),
            expect.objectContaining({ id: 'filter:empty' }),
            expect.objectContaining({ id: 'filter:cutoff' }),
            expect.objectContaining({ id: 'filter:unresolved' }),
            expect.objectContaining({ id: 'filter:aux-failure' }),
          ],
        },
      },
      pagedAll: {
        ok: true,
        value: {
          problems: [
            expect.objectContaining({ id: 'filter:wait-104' }),
            expect.objectContaining({ id: 'filter:wait-103' }),
            expect.objectContaining({ id: 'filter:wait-102' }),
          ],
        },
      },
    })
  })
}
