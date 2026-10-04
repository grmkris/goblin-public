import { describe, expect, it } from 'vitest'
import { conversationParts } from '../src/lib/parts.ts'
import { projectBatch, projectSnapshot } from '../src/lib/projection.ts'

const call = (id: string, args: Record<string, unknown> = {}) => ({
  type: 'toolCall',
  id,
  name: 'mcp_call',
  arguments: args,
})
const asking = (id: number, calls: readonly Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  id,
  model: [{ role: 'assistant', content: calls, stopReason: 'toolUse', timestamp: 1_000, ...extra }],
})
const result = (id: number, toolCallId: string, isError = false) => ({
  id,
  model: [{ role: 'toolResult', toolCallId, toolName: 'mcp_call', isError, content: 'out', timestamp: 4_500 }],
})
const snapshot = (entries: readonly unknown[], extra: Record<string, unknown> = {}) =>
  projectSnapshot({ type: 'snapshot', entries, tools: [], inbox: [], ...extra })

describe('the transcript as render parts', () => {
  it('folds each result into the call that asked for it, with the MCP target and its timing', () => {
    const args = { serverId: 'myplan', name: 'myplan_open', arguments: { note: 'n1' } }
    const parts = conversationParts(
      snapshot([
        { id: 1, model: [{ role: 'user', content: 'open it' }] },
        asking(2, [call('c1', args)]),
        result(3, 'c1'),
      ]),
    )
    expect(parts.map((part) => [part.kind, part.id])).toEqual([
      ['user', '1:0'],
      ['tool', 'tool:c1'],
    ])
    expect(parts[1]).toMatchObject({
      state: 'done',
      target: { serverId: 'myplan', name: 'myplan_open', arguments: { note: 'n1' } },
      startedAt: 1_000,
      endedAt: 4_500,
      result: { text: 'out' },
    })
  })
  it('tells a failed, a queued, a running and a stopped call apart', () => {
    const entries = [asking(1, [call('bad'), call('queued'), call('live')]), result(2, 'bad', true)]
    const running = projectBatch(
      snapshot(entries, { run: { inputs: [1] } }),
      [{ type: 'tool_execution_start', toolCallId: 'live', toolName: 'mcp_call', args: {} }],
      2_000,
    )
    expect(
      conversationParts(running).map((part) => (part.kind === 'tool' ? [part.id, part.state] : part.kind)),
    ).toEqual([
      ['tool:bad', 'error'],
      ['tool:queued', 'pending'],
      ['tool:live', 'running'],
    ])
    const live = conversationParts(running).find((part) => part.id === 'tool:live')
    expect(live).toMatchObject({ startedAt: 2_000 })
    const ended = projectBatch(running, [{ type: 'run_end' }])
    expect(conversationParts(ended).find((part) => part.id === 'tool:queued')).toMatchObject({ state: 'stopped' })
  })
  it('shows a live tool before its asking message is committed, then the streaming thinking and text', () => {
    const next = projectBatch(snapshot([], { run: { inputs: [1] } }), [
      { type: 'tool_execution_start', toolCallId: 'early', toolName: 'mcp_list', args: { serverId: 'x' } },
      {
        type: 'message_update',
        changes: [
          { type: 'thinking_start', contentIndex: 0, block: { type: 'thinking', thinking: 'Plan' } },
          { type: 'text_start', contentIndex: 1, block: { type: 'text', text: 'Hi' } },
        ],
      },
    ])
    expect(conversationParts(next)).toEqual([
      expect.objectContaining({
        kind: 'tool',
        id: 'tool:early',
        state: 'running',
        call: { id: 'early', name: 'mcp_list', arguments: { serverId: 'x' } },
      }),
      { kind: 'reasoning', id: 'partial:reasoning', text: 'Plan', live: true },
      { kind: 'text', id: 'partial:text', text: 'Hi', live: true },
    ])
  })
  it('keeps a result whose call was compacted away, and puts a failure after the turn it ended', () => {
    const parts = conversationParts(
      snapshot([result(1, 'gone'), { id: 2, model: [{ role: 'assistant', content: [], stopReason: 'aborted' }] }]),
    )
    expect(parts.map((part) => [part.kind, part.id])).toEqual([
      ['tool', 'tool:gone'],
      ['failure', '2:0:failure'],
    ])
  })
})
