import { describe, expect, it } from 'vitest'
import { conversationParts } from '../src/lib/conversation-parts.ts'
import {
  elapsedMs,
  isOwnTurn,
  type Part,
  partKey,
  samePart,
  toolLine,
  type ToolPart,
  type ToolState,
} from '../src/lib/parts.ts'
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
  it("reads an MCP call's arguments sent as the JSON string of an object", () => {
    const args = { connectionId: 'myplan', name: 'myplan_open', arguments: '{"note":"n1"}' }
    const parts = conversationParts(snapshot([asking(2, [call('c1', args)]), result(3, 'c1')]))
    expect(parts[0]).toMatchObject({
      target: { connectionId: 'myplan', name: 'myplan_open', arguments: { note: 'n1' } },
    })
  })

  it('folds each result into the call that asked for it, with the MCP target and its timing', () => {
    const args = { connectionId: 'myplan', name: 'myplan_open', arguments: { note: 'n1' } }
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
      target: { connectionId: 'myplan', name: 'myplan_open', arguments: { note: 'n1' } },
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
  it('shows the streaming thinking and text, then a live tool whose asking message is not committed yet', () => {
    const next = projectBatch(snapshot([], { run: { inputs: [1] } }), [
      { type: 'tool_execution_start', toolCallId: 'early', toolName: 'mcp_list', args: { connectionId: 'x' } },
      {
        type: 'message_update',
        changes: [
          { type: 'thinking_start', contentIndex: 0, block: { type: 'thinking', thinking: 'Plan' } },
          { type: 'text_start', contentIndex: 1, block: { type: 'text', text: 'Hi' } },
        ],
      },
    ])
    // The order a committed message has, so the tool row does not change places when its message commits.
    expect(conversationParts(next)).toEqual([
      { kind: 'reasoning', id: 'partial:reasoning', text: 'Plan', live: true },
      { kind: 'text', id: 'partial:text', text: 'Hi', live: true },
      expect.objectContaining({
        kind: 'tool',
        id: 'tool:early',
        state: 'running',
        call: { id: 'early', name: 'mcp_list', arguments: { connectionId: 'x' } },
      }),
    ])
  })
  it('keeps one React key for a message from its first token to its commit, so an open Thoughts stays open', () => {
    const message = { role: 'assistant', timestamp: 7_000, content: [] }
    const streaming = projectBatch(snapshot([], { run: { inputs: [1] } }), [
      { type: 'message_start', message },
      {
        type: 'message_update',
        changes: [
          { type: 'thinking_start', contentIndex: 0, block: { type: 'thinking', thinking: 'Plan' } },
          { type: 'text_start', contentIndex: 1, block: { type: 'text', text: 'Hi' } },
        ],
      },
    ])
    const live = conversationParts(streaming).map(partKey)
    const committed = projectBatch(streaming, [
      {
        type: 'message_end',
        entry: {
          id: 5,
          model: [
            {
              ...message,
              content: [
                { type: 'thinking', thinking: 'Plan' },
                { type: 'text', text: 'Hi' },
              ],
              stopReason: 'stop',
            },
          ],
        },
      },
    ])
    const parts = conversationParts(committed)
    expect(live).toEqual(['at:7000:reasoning', 'at:7000:text'])
    expect(parts.map(partKey)).toEqual(live)
    expect(parts.map((part) => part.id)).toEqual(['5:0:reasoning', '5:0:text'])
  })
  it('tells an unchanged part from a changed one across batches, so only changed rows render', () => {
    const entries = [asking(2, [call('c1', { a: 1 })]), result(3, 'c1')]
    const first = conversationParts(snapshot(entries))
    const again = conversationParts(snapshot(entries))
    expect(first.map((part, index) => samePart(part, again[index] ?? part))).toEqual([true])
    const text = { kind: 'text', id: 't', text: 'Hi', live: true } as const
    expect(samePart(text, { ...text })).toBe(true)
    expect(samePart(text, { ...text, text: 'Hi there' })).toBe(false)
    expect(samePart(text, { ...text, live: false })).toBe(false)
    expect(samePart(text, { kind: 'reasoning', id: 't', text: 'Hi', live: true })).toBe(false)
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

const toolAt = (state: ToolState, times: { readonly startedAt?: number; readonly endedAt?: number }): ToolPart => ({
  kind: 'tool',
  id: 'tool:c',
  call: { id: 'c', name: 'mcp_list', arguments: {} },
  state,
  ...times,
})

describe('a thread started with + in main', () => {
  it('is its own part between the messages around it', () => {
    const parts = conversationParts(
      snapshot([
        { id: 1, model: [{ role: 'user', content: 'hello' }] },
        { id: 2, kind: 'app.thread_started', data: { thread: '7' }, model: [{ role: 'user', content: 'x' }] },
      ]),
    )
    expect(parts.map((part) => part.kind)).toEqual(['user', 'thread-started'])
    expect(parts[1]).toEqual({ kind: 'thread-started', id: '2:0', thread: '7' })
  })
})

describe("a decided call's outcome kept for the next turn", () => {
  const outcome = {
    continuation: { kind: 'approval', connectionId: 'board', name: 'post', state: 'completed' },
    origin: { connectionId: 'board', trust: 'untrusted' },
    result: { posted: true },
  }
  const content = [
    { type: 'text', text: '[from Board]' },
    { type: 'text', text: 'Approved "Board" (board) · post; the held call returned.' },
    { type: 'text', text: JSON.stringify(outcome) },
  ]
  const kept = { id: 3, kind: 'app.mcp_outcome', data: outcome.continuation, model: [{ role: 'user', content }] }
  it('is its outcome row, marked as waiting for the next turn while nothing came after it', () => {
    const [part] = conversationParts(snapshot([kept]))
    expect(part).toMatchObject({ kind: 'user', author: 'Board', outcome, kept: true })
  })
  it('reads as any other outcome once something follows it', () => {
    const next = { id: 4, model: [{ role: 'user', content: 'what did it say?' }] }
    const [part] = conversationParts(snapshot([kept, next]))
    expect(part).toMatchObject({ kind: 'user', outcome })
    expect(part).not.toHaveProperty('kept')
    // The same outcome sent as a turn is never marked.
    const sent = { id: 3, model: [{ role: 'user', content }] }
    expect(conversationParts(snapshot([sent]))[0]).not.toHaveProperty('kept')
  })
})

describe('how long a tool ran', () => {
  it('counts to now while running and to the result once done', () => {
    expect(elapsedMs(toolAt('running', { startedAt: 1_000 }), 3_500)).toBe(2_500)
    expect(elapsedMs(toolAt('done', { startedAt: 1_000, endedAt: 1_800 }), 9_000)).toBe(800)
  })
  it('has no time without a start, or for a call that never ran', () => {
    expect(elapsedMs(toolAt('running', {}), 3_500)).toBeUndefined()
    expect(elapsedMs(toolAt('stopped', { startedAt: 1_000 }), 3_500)).toBeUndefined()
  })
  it('never goes negative when clocks disagree', () => {
    expect(elapsedMs(toolAt('done', { startedAt: 5_000, endedAt: 4_000 }), 9_000)).toBe(0)
  })
})

describe('a tool call as one line', () => {
  it('names the server and the tool of an MCP call', () => {
    const part: ToolPart = {
      ...toolAt('done', {}),
      call: { id: 'c', name: 'mcp_call', arguments: {} },
      target: { connectionId: 'board', name: 'move', arguments: {} },
    }
    expect(toolLine(part)).toEqual({ lead: 'Used', server: 'board', tool: 'move' })
  })
  it('names the app and the member of an app_call', () => {
    const appCall = { id: 'c', name: 'app_call', arguments: { app: 'reading-list', member: 'add', input: {} } }
    expect(toolLine({ ...toolAt('done', {}), call: appCall })).toEqual({
      lead: 'Used',
      server: 'reading-list',
      tool: 'add',
    })
  })
  it('says what the agent did with its own tools, and names any other', () => {
    expect(toolLine(toolAt('done', {}))).toEqual({ lead: 'Looked up its tools' })
    const other: ToolPart = { ...toolAt('done', {}), call: { id: 'c', name: 'remember', arguments: {} } }
    expect(toolLine(other)).toEqual({ lead: 'Used remember' })
  })
})

const user = (author?: string): Part => ({
  kind: 'user',
  id: 'u',
  text: 'hi',
  ...(author !== undefined && { author }),
})

describe("the owner's own turns", () => {
  it('counts what the owner typed here or sent from Telegram', () => {
    expect(isOwnTurn(user())).toBe(true)
    expect(isOwnTurn(user('Telegram'))).toBe(true)
  })
  it('leaves out messages from an MCP client, a subagent, a routine or a thread', () => {
    for (const author of ['Claude Code', 'subagent scout', 'Routine', 'thread "Car search"'])
      expect(isOwnTurn(user(author))).toBe(false)
  })
  it('is never a reply', () => {
    expect(isOwnTurn({ kind: 'text', id: 't', text: 'hi', live: false })).toBe(false)
  })
})

const build = (id: string) => ({ type: 'toolCall', id, name: 'app_build', arguments: { name: 'tapper' } })
const built = (id: number, toolCallId: string, text: string) => ({
  id,
  model: [{ role: 'toolResult', toolCallId, toolName: 'app_build', isError: false, content: text, timestamp: 4_500 }],
})
const active = (version: number, ui: boolean) =>
  JSON.stringify({ status: 'active', app: 'tapper', release: 'r_1', version, tools: [], revision: 1, ui })

describe('app builds in the transcript', () => {
  it('shows an app view under the newest build that has one, and reads failed builds as none', () => {
    const parts = conversationParts(
      snapshot([
        asking(1, [build('b1')]),
        built(2, 'b1', active(1, true)),
        asking(3, [build('b2')]),
        built(4, 'b2', JSON.stringify({ status: 'failed', app: 'tapper', problems: [] })),
        asking(5, [build('b3')]),
        built(6, 'b3', active(2, true)),
        asking(7, [build('b4')]),
        built(8, 'b4', active(3, false)),
      ]),
    ).filter((part): part is ToolPart => part.kind === 'tool')
    expect(parts.map((part) => part.built)).toEqual([
      { app: 'tapper', version: 1, ui: true, place: false },
      undefined,
      { app: 'tapper', version: 2, ui: true, place: true },
      { app: 'tapper', version: 3, ui: false, place: false },
    ])
  })
})

const answered = (id: number, text: string) => ({
  id,
  model: [{ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: 2_000 }],
})

describe('the working row and the echo of a sent message', () => {
  const owner = { id: 1, model: [{ role: 'user', content: 'hello' }] }
  it('says the turn is under way after the owner’s message and after a tool result, until something streams', () => {
    const afterMessage = conversationParts(snapshot([owner], { run: {} }))
    expect(afterMessage.map((part) => part.kind)).toEqual(['user', 'working'])
    const afterTool = conversationParts(snapshot([owner, asking(2, [call('c1')]), result(3, 'c1')], { run: {} }))
    expect(afterTool.map((part) => part.kind)).toEqual(['user', 'tool', 'working'])
  })
  it('does not say it while idle, while something shows, or after an answer a finishing turn leaves last', () => {
    expect(conversationParts(snapshot([owner])).some((part) => part.kind === 'working')).toBe(false)
    const streaming = projectBatch(snapshot([owner], { run: {} }), [
      { type: 'message_start', message: { role: 'assistant', timestamp: 7_000, content: [] } },
      {
        type: 'message_update',
        changes: [{ type: 'text_start', contentIndex: 0, block: { type: 'text', text: 'Hi' } }],
      },
    ])
    expect(conversationParts(streaming).some((part) => part.kind === 'working')).toBe(false)
    const running = projectBatch(snapshot([owner], { run: {} }), [
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'mcp_call', args: {} },
    ])
    expect(conversationParts(running).some((part) => part.kind === 'working')).toBe(false)
    const ending = snapshot([owner, answered(2, 'Done.')], { run: {} })
    expect(conversationParts(ending).some((part) => part.kind === 'working')).toBe(false)
  })
  it('shows a message just sent before the stream delivers it, and keeps its key for the server’s entry', () => {
    const echo = { id: 'echo:op-1', text: 'hello', after: 0 }
    const sending = conversationParts(snapshot([]), echo)
    expect(sending).toEqual([
      { kind: 'user', id: 'echo:op-1', key: 'echo:op-1', text: 'hello' },
      { kind: 'working', id: 'working' },
    ])
    const delivered = conversationParts(snapshot([owner], { run: {} }), echo)
    expect(delivered.map((part) => [part.kind, part.id, partKey(part)])).toEqual([
      ['user', '1:0', 'echo:op-1'],
      ['working', 'working', 'working'],
    ])
    // The same row throughout: the echo's key is the server's entry's key.
    expect(sending.map(partKey)[0]).toBe(delivered.map(partKey)[0])
  })
  it('leaves an older message alone when the echo’s own has not arrived', () => {
    const echo = { id: 'echo:op-2', text: 'again', after: 1 }
    const parts = conversationParts(snapshot([owner, answered(2, 'Hi')]), echo)
    expect(parts.map((part) => part.id)).toEqual(['1:0', '2:0:text', 'echo:op-2', 'working'])
  })
})

const toolOf = (state: ReturnType<typeof snapshot>) =>
  conversationParts(state).find((part): part is ToolPart => part.kind === 'tool')

describe('a tool row’s time', () => {
  it('keeps the start and end this browser saw after the run ends, not the asking message’s start and the server’s end', () => {
    // The asking message began at 1_000 and the server stamped the result 4_500; the tool ran 10_000 to 19_500 here.
    let state = snapshot([{ id: 1, model: [{ role: 'user', content: 'go' }] }], { run: {} })
    state = projectBatch(state, [{ type: 'message_end', entry: asking(2, [call('c1')]) }], 5_000)
    state = projectBatch(
      state,
      [{ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'mcp_call', args: {} }],
      10_000,
    )
    state = projectBatch(state, [{ type: 'tool_execution_end', toolCallId: 'c1', entry: result(3, 'c1') }], 19_500)
    expect(toolOf(state)).toMatchObject({ state: 'done', startedAt: 10_000, endedAt: 19_500 })
    const ended = projectBatch(state, [{ type: 'run_end' }], 20_000)
    expect(toolOf(ended)).toMatchObject({ state: 'done', startedAt: 10_000, endedAt: 19_500 })
  })
  it('falls back to the asking message and the result’s own stamp for a tool this browser did not see run', () => {
    const state = snapshot([asking(2, [call('c1')]), result(3, 'c1')])
    expect(toolOf(state)).toMatchObject({ startedAt: 1_000, endedAt: 4_500 })
  })
})
