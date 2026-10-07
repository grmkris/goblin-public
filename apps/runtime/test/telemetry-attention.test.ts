import { RunAttribute, type RunEvent } from '@goblin/contracts/telemetry'
import { describe, expect, it } from 'vitest'
import { needsAttention } from '../src/telemetry/attention.ts'
import { coverageGaps } from '../src/inspect/coverage.ts'
import { safeErrorType, safeFailureCode, sanitizeAttributes } from '../src/telemetry/safety.ts'

const event = (overrides: Partial<RunEvent> = {}): RunEvent => ({
  id: 'failed',
  kind: 'model.attempt',
  status: 'error',
  operationId: 'op',
  conversationId: '1',
  taskId: 'task',
  startedAt: 10,
  endedAt: 20,
  attributes: {},
  ...overrides,
})

describe('safe telemetry and attention', () => {
  it('keeps arbitrary error text and unknown classes out, including legacy attributes', () => {
    const text = 'PRIVATE_APP_SOURCE_7fd8'
    expect(safeErrorType(new Error(text))).toBe('Error')
    expect(safeErrorType({ _tag: text, reason: text, message: text })).toBe('error')
    expect(safeErrorType({ _tag: 'UpstreamMcp', reason: text })).toBe('UpstreamMcp')
    expect(safeFailureCode(`UpstreamMcp:${text}`)).toBe('error')
    const safe = sanitizeAttributes({ 'error.type': text, 'goblin.error': text, 'goblin.reason': text, payload: text })
    expect(JSON.stringify(safe)).not.toContain(text)
    expect(safe['error.type']).toBe('error')
    expect(sanitizeAttributes(safe)).toEqual(safe)
    expect(sanitizeAttributes({ [RunAttribute.errorType]: 'provider_error', [RunAttribute.error]: text })).toEqual({
      [RunAttribute.errorType]: 'provider_error',
      [RunAttribute.error]: 'Model provider failed.',
    })
  })

  it('hides only confirmed model retries and known authority waits', () => {
    const failed = event()
    const success = event({ id: 'success', status: 'ok', startedAt: 25, endedAt: 30 })
    expect(needsAttention(failed, [success])).toBe(false)
    expect(needsAttention(failed, [event({ ...success, taskId: 'other' })])).toBe(true)
    expect(needsAttention(failed, [event({ ...success, operationId: 'other' })])).toBe(true)
    expect(needsAttention(event({ status: 'interrupted' }), [success])).toBe(false)
    expect(needsAttention(event({ status: 'interrupted' }), [])).toBe(true)
    expect(
      needsAttention(event({ status: 'interrupted', attributes: { [RunAttribute.reason]: 'aborted' } }), [success]),
    ).toBe(true)
    expect(
      needsAttention(event({ status: 'interrupted', attributes: { [RunAttribute.finishReason]: 'aborted' } }), [
        success,
      ]),
    ).toBe(true)
    expect(needsAttention(event({ kind: 'tool.call' }), [event({ ...success, kind: 'tool.call' })])).toBe(true)
    expect(
      needsAttention(event({ status: 'blocked', attributes: { [RunAttribute.errorType]: 'NeedsAuthorization' } }), []),
    ).toBe(false)
    expect(needsAttention(event({ status: 'blocked', attributes: { [RunAttribute.errorType]: 'blocked' } }), [])).toBe(
      true,
    )
  })

  it('keeps cutoffs, empty answers, and coverage gaps visible even for a successful turn', () => {
    for (const flag of [RunAttribute.cutoff, RunAttribute.emptyAnswer, RunAttribute.coverageGap])
      expect(needsAttention(event({ status: 'ok', attributes: { [flag]: true } }), [])).toBe(true)
    expect(needsAttention(event({ status: 'ok', attributes: { [RunAttribute.finishReason]: 'length' } }), [])).toBe(
      true,
    )
    expect(
      needsAttention(event(), [
        event({ id: 'cutoff', status: 'ok', startedAt: 25, attributes: { [RunAttribute.cutoff]: true } }),
      ]),
    ).toBe(true)
  })

  it('checks coverage against the actual Pi answer instead of an earlier successful model attempt', () => {
    const turn = event({ kind: 'turn.submitted', status: 'ok' })
    const early = event({ id: 'early', status: 'ok', attributes: { [RunAttribute.entry]: 505 } })
    expect(coverageGaps(turn, [early], { status: 'done', answer: 517 })).toContain(
      "Pi's final answer is missing from the run timeline; later work may be uncorrelated.",
    )
    expect(
      coverageGaps(turn, [event({ ...early, attributes: { [RunAttribute.entry]: 517 } })], {
        status: 'done',
        answer: 517,
      }),
    ).toEqual([])
  })
})
