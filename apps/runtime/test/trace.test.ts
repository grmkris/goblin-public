import { RunAttribute, type RunEvent } from '@goblin/contracts/telemetry'
import { describe, expect, it } from 'vitest'
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

  it('opens a span when the event starts and ends it with its attributes and status', () => {
    const { spans, tracer } = fakeTracer()
    const sink = new TraceSink(tracer, () => 'user-1')
    sink.started(event({}))
    expect(spans).toMatchObject([
      {
        name: 'chat gpt-test',
        ended: false,
        attributes: { 'gen_ai.agent.name': 'goblin', 'gen_ai.agent.id': 'user-1', 'gen_ai.conversation.id': '1' },
      },
    ])
    sink.ended(event({ status: 'error', endedAt: 20, attributes: { [RunAttribute.error]: 'rate limited' } }))
    expect(spans[0]).toMatchObject({
      ended: true,
      status: { code: 'error', message: 'rate limited' },
      attributes: { 'goblin.error': 'rate limited', 'goblin.status': 'error', 'goblin.operation': 'telegram-12' },
    })
  })

  it('ignores an end without its start, and bounds the open spans', () => {
    const { spans, tracer } = fakeTracer()
    const sink = new TraceSink(tracer, () => 'user-1')
    sink.ended(event({ status: 'ok' }))
    expect(spans).toHaveLength(0)
    for (let index = 0; index < 201; index++) sink.started(event({ id: `model:${index}` }))
    expect(spans.filter((span) => span.ended)).toEqual([expect.objectContaining({ status: { code: 'unset' } })])
  })
})
