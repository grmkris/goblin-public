import { describe, expect, it } from 'vitest'
import { projectBatch, projectSnapshot } from '../src/lib/projection.ts'

describe('Pi committed state projected for the chat', () => {
  it('projects Pi whole-block replacements without duplicating streamed text', () => {
    const initial = projectSnapshot({ type: 'snapshot', entries: [], tools: [], inbox: [] })
    const next = projectBatch(initial, [
      {
        type: 'message_update',
        changes: [
          { type: 'text_start', contentIndex: 0, block: { type: 'text', text: 'First' } },
          { type: 'text_delta', contentIndex: 0, delta: ' draft' },
          { type: 'block', contentIndex: 0, block: { type: 'text', text: 'Replaced' } },
          { type: 'text_start', contentIndex: 1, block: { type: 'text', text: 'Second' } },
        ],
      },
    ])
    expect(next.partial).toBe('Replaced\nSecond')
  })
  it('maps native entries, deduplicates events sharing an entry, and replaces state on snapshots', () => {
    const entry = { id: 1, kind: 'user', model: [{ role: 'user', content: 'hello' }] }
    const first = projectSnapshot({ type: 'snapshot', entries: [entry], tools: [], inbox: [], run: { inputs: [1] } })
    expect(first.messages[0]).toEqual({ id: '1:0', role: 'user', text: 'hello' })
    const duplicate = projectBatch(first, [
      { type: 'entry_appended', entry },
      { type: 'message_end', entry },
    ])
    expect(duplicate.messages).toHaveLength(1)
    expect(projectBatch(duplicate, [{ type: 'snapshot', entries: [], tools: [], inbox: [] }]).messages).toEqual([])
  })
  it('projects committed tool progress and clears in-flight text after a run ends', () => {
    const snapshot = projectSnapshot({ type: 'snapshot', entries: [], tools: [], inbox: [] })
    const next = projectBatch(snapshot, [
      { type: 'run_start' },
      { type: 'message_update', changes: [{ type: 'text_delta', contentIndex: 0, delta: 'Working' }] },
      { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'search' },
      { type: 'tool_execution_update', toolCallId: 'call-1', output: { append: 'Found one' } },
    ])
    expect(next.partial).toBe('Working')
    expect(next.tools[0]?.output).toBe('Found one')
    expect(projectBatch(next, [{ type: 'run_end' }])).toMatchObject({ running: false, partial: '', progress: 'Ready' })
  })
  it('keeps tool calls and results with the fields the chat renders', () => {
    const entries = [
      {
        id: 3,
        model: [
          {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: 'c1', name: 'mcp_call', arguments: { serverId: 'myplan', name: 'open' } },
            ],
          },
        ],
      },
      {
        id: 4,
        model: [
          {
            role: 'toolResult',
            toolCallId: 'c1',
            toolName: 'mcp_call',
            isError: false,
            content: 'ok',
            details: { a: 1 },
          },
        ],
      },
    ]
    const projection = projectSnapshot({ type: 'snapshot', entries, tools: [], inbox: [] })
    expect(projection.messages).toEqual([
      {
        id: '3:0',
        role: 'assistant',
        text: '',
        toolCalls: [{ id: 'c1', name: 'mcp_call', arguments: { serverId: 'myplan', name: 'open' } }],
      },
      {
        id: '4:0',
        role: 'tool',
        text: 'ok',
        toolCallId: 'c1',
        toolName: 'mcp_call',
        isError: false,
        details: { a: 1 },
      },
    ])
  })
})
