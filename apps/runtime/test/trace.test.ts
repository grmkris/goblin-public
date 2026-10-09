import { RunAttribute, type RunEvent } from '@goblin/contracts/telemetry'
import { describe, expect, it } from 'vitest'
import type { RunSink } from '../src/telemetry/events.ts'
import { type TraceSpan, TraceSink, spanNameOf } from '../src/telemetry/trace.ts'

type Recorded = { name: string; attributes: Record<string, unknown>; status?: unknown; ended: boolean }

function fakeTracer() {
  const spans: Recorded[] = []
  return {
    spans,
    tracer: {
      startSpan(name: string): TraceSpan {
        const span: Recorded = { name, attributes: {}, ended: false }
        spans.push(span)
        return {
          setAttributes: (attributes) => Object.assign(span.attributes, attributes),
          setStatus: (status) => {
            span.status = status
          },
          end: () => {
            span.ended = true
          },
        }
      },
    },
  }
}

const event = (overrides: Partial<RunEvent>): RunEvent => ({
  id: 'model:t1:1:0',
  kind: 'model.attempt',
  status: 'started',
  conversationId: '1',
  operationId: 'telegram-12',
  startedAt: 10,
  attributes: { [RunAttribute.requestModel]: 'gpt-test' },
  ...overrides,
})

describe('run events as trace spans (unit, ADR 0024)', () => {
  it('names model and tool calls after the GenAI conventions, and nothing else', () => {
    expect(spanNameOf(event({}))).toBe('chat gpt-test')
    expect(spanNameOf(event({ kind: 'tool.call', attributes: { [RunAttribute.toolName]: 'mcp_call' } }))).toBe(
      'execute_tool mcp_call',
    )
    expect(spanNameOf(event({ kind: 'turn.submitted' }))).toBeUndefined()
    expect(spanNameOf(event({ kind: 'channel.reply' }))).toBeUndefined()
  })

  it('writes each call as one span when it ends, with its attributes, real timing and status', () => {
    const { spans, tracer } = fakeTracer()
    const sink: RunSink = new TraceSink(tracer, () => 'user-1')
    sink.started(event({}))
    expect(spans).toHaveLength(0)
    sink.ended(
      event({ status: 'error', endedAt: 1_250, attributes: { [RunAttribute.error]: 'Unclassified failure.' } }),
    )
    expect(spans).toMatchObject([
      {
        name: 'chat model',
        ended: true,
        status: { code: 'error', message: 'Unclassified failure.' },
        attributes: {
          'gen_ai.agent.name': 'goblin',
          'gen_ai.agent.id': 'user-1',
          'gen_ai.conversation.id': '1',
          'goblin.error': 'Unclassified failure.',
          'goblin.status': 'error',
          'goblin.operation': 'telegram-12',
          'goblin.started_at': 10,
          'goblin.duration_ms': 1_240,
        },
      },
    ])
  })

  it('keeps expected owner decisions visible without marking them as infrastructure errors', () => {
    const { spans, tracer } = fakeTracer()
    const sink = new TraceSink(tracer, () => 'user-1')
    sink.ended(event({ kind: 'tool.call', status: 'blocked', attributes: { [RunAttribute.errorType]: 'GrantDenied' } }))
    expect(spans).toMatchObject([{ status: { code: 'unset' }, attributes: { 'goblin.status': 'blocked' } }])
  })

  it('ends the span where the runtime has no setStatus', () => {
    let ended = false
    const sink = new TraceSink(
      { startSpan: () => ({ setAttributes: () => undefined, end: () => (ended = true) }) },
      () => 'user-1',
    )
    sink.ended(event({ status: 'ok', endedAt: 30 }))
    expect(ended).toBe(true)
  })

  it('ends a call that started in an earlier invocation as well, and leaves other events out', () => {
    const { spans, tracer } = fakeTracer()
    const sink = new TraceSink(tracer, () => 'user-1')
    sink.ended(event({ status: 'ok', endedAt: 30 }))
    sink.ended(event({ kind: 'turn.submitted', status: 'ok' }))
    expect(spans).toMatchObject([{ name: 'chat gpt-test', status: { code: 'ok' }, ended: true }])
  })
})
