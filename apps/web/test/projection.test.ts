import { describe, expect, it } from 'vitest'
import { EventType } from '@ag-ui/core'
import { projectBatch, projectSnapshot } from '../src/lib/projection.ts'

describe('Pi committed state projected to AG-UI', () => {
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
    expect(first.messages.type).toBe(EventType.MESSAGES_SNAPSHOT)
    expect(first.messages.messages[0]).toEqual({ id: '1:0', role: 'user', content: 'hello' })
    const duplicate = projectBatch(first, [
      { type: 'entry_appended', entry },
      { type: 'message_end', entry },
    ])
    expect(duplicate.messages.messages).toHaveLength(1)
    expect(
      projectBatch(duplicate, [{ type: 'snapshot', entries: [], tools: [], inbox: [] }]).messages.messages,
    ).toEqual([])
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
})
