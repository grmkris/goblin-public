import { describe, expect, it } from 'vitest'
import {
  type Part,
  type ReasoningPart,
  type ToolPart,
  type ToolState,
  type WorkingPart,
  partKey,
  samePart,
} from '../src/lib/parts.ts'
import { groupWork, liveLabel, stepCount, stepLines } from '../src/lib/work-groups.ts'

const none = { appCalls: new Set<string>() }
const user = (id = '1:0'): Part => ({ kind: 'user', id, text: 'go' })
const answer = (id = '9:0:text'): Part => ({ kind: 'text', id, text: 'Done.', live: false })
const thoughts = (id: string, live = false): ReasoningPart => ({ kind: 'reasoning', id, text: 'hm', live })
const working: WorkingPart = { kind: 'working', id: 'working' }
const call = (id: string, state: ToolState = 'done', server?: string, extra: Partial<ToolPart> = {}): ToolPart => ({
  kind: 'tool',
  id: `tool:${id}`,
  call: { id, name: server === undefined ? 'web_fetch' : 'mcp_call', arguments: {} },
  ...(server !== undefined && { target: { serverId: server, name: `t_${id}`, arguments: {} } }),
  state,
  ...extra,
})
const kinds = (parts: readonly Part[]) => parts.map((part) => part.kind)
const works = (parts: readonly Part[]) => parts.flatMap((part) => (part.kind === 'work' ? [part] : []))

describe('folding a turn’s quiet work', () => {
  it('folds a run of thinking and tool calls into one part and leaves the answer outside', () => {
    const parts = groupWork([user(), thoughts('a'), call('c1'), thoughts('b'), call('c2'), answer()], none)
    expect(kinds(parts)).toEqual(['user', 'work', 'text'])
    expect(parts[1]).toMatchObject({ id: 'work:1:0', key: 'work:1:0', live: false })
    expect(works(parts)[0]?.steps).toHaveLength(4)
  })
  it('keeps a single step as it is: one line is already as short as its summary', () => {
    expect(kinds(groupWork([user(), call('c1'), answer()], none))).toEqual(['user', 'tool', 'text'])
    expect(kinds(groupWork([user(), working], none))).toEqual(['user', 'working'])
  })
  it('leaves what the owner must see or act on where it is, and folds the rest around it', () => {
    const parts = groupWork(
      [
        user(),
        call('a'),
        call('b'),
        call('failed', 'error'),
        call('c'),
        call('d'),
        call('app', 'done', 'myplan'),
        call('sub', 'running', undefined, { call: { id: 'sub', name: 'subagent_spawn', arguments: {} } }),
        call('build', 'done', undefined, { built: { app: 'tapper', version: 1, ui: true, place: true } }),
      ],
      { appCalls: new Set(['app']) },
    )
    expect(parts.map((part) => (part.kind === 'tool' ? part.id : part.kind))).toEqual([
      'user',
      'work',
      'tool:failed',
      'work',
      'tool:app',
      'tool:sub',
      'tool:build',
    ])
  })
  it('folds a call to a server that has no App open, but not one whose App is open and done', () => {
    const open = groupWork([user(), call('a', 'done', 'myplan'), call('b', 'done', 'myplan')], {
      appCalls: new Set(['a']),
    })
    expect(kinds(open)).toEqual(['user', 'tool', 'tool'])
    expect(kinds(groupWork([user(), call('a', 'done', 'myplan'), call('b', 'done', 'myplan')], none))).toEqual([
      'user',
      'work',
    ])
  })
  it('splits runs at text, so a turn that narrates between rounds has a line per round, each with its own key', () => {
    const parts = groupWork(
      [user(), call('a'), call('b'), answer('5:0:text'), call('c'), call('d'), answer('9:0:text')],
      none,
    )
    expect(kinds(parts)).toEqual(['user', 'work', 'text', 'work', 'text'])
    expect(parts.filter((part) => part.kind === 'work').map(partKey)).toEqual(['work:1:0', 'work:5:0:text'])
  })
  it('says it is live while a tool runs, thinking streams or the working row waits, and not once everything settled', () => {
    const live = (run: Part[]) => works(groupWork([user(), ...run], none))[0]?.live
    expect(live([call('a'), call('b', 'running')])).toBe(true)
    expect(live([call('a'), thoughts('t', true)])).toBe(true)
    expect(live([call('a'), working])).toBe(true)
    expect(live([call('a'), call('b'), thoughts('t')])).toBe(false)
  })
  it('keeps one key as steps join the run, including the working row that the first real step replaces', () => {
    const early = groupWork([user(), call('a'), working], none)[1]
    const later = groupWork([user(), call('a'), call('b'), working], none)[1]
    expect(early && partKey(early)).toBe(later && partKey(later))
  })
})

describe('the open group’s lines', () => {
  it('merges calls in a row to one server, keeping their order, and leaves a lone call a plain step', () => {
    const lines = stepLines([
      call('a', 'done', 's1'),
      call('b', 'done', 's1'),
      call('c', 'done', 's2'),
      thoughts('t'),
      call('d', 'done', 's1'),
    ])
    expect(
      lines.map((line) => (line.kind === 'server' ? `${line.server}×${line.calls.length}` : line.step.kind)),
    ).toEqual(['s1×2', 'tool', 'reasoning', 'tool'])
  })
  it('does not merge calls with no server, which are the agent’s own tools', () => {
    expect(stepLines([call('a'), call('b')]).map((line) => line.kind)).toEqual(['step', 'step'])
  })
})

describe('what the folded line says', () => {
  it('names the tool that is running, a count when several run at once, else that the model is thinking', () => {
    expect(liveLabel([call('a'), call('b', 'running', 'myplan')])).toBe('Using myplan · t_b')
    expect(liveLabel([call('a', 'running')])).toBe('Using web_fetch')
    expect(liveLabel([call('a', 'running', 'myplan'), call('b', 'running', 'myplan')])).toBe('Using myplan · 2 tools')
    expect(liveLabel([call('a', 'running', 'myplan'), call('b', 'running')])).toBe('Using 2 tools')
    expect(liveLabel([call('a'), working])).toBe('Thinking…')
  })
  it('does not call a call that was asked for and has not started running', () => {
    expect(liveLabel([call('a', 'pending', 'myplan'), call('b', 'pending', 'myplan')])).toBe('Thinking…')
  })
  it('counts tool calls as the steps', () => {
    expect(stepCount([thoughts('t'), call('a'), call('b'), working])).toBe(2)
  })
  it('is the same part while its steps are, by what they draw', () => {
    const [one, two, three] = [call('a'), call('b'), call('c')]
    const a = groupWork([user(), one, two], none)[1]
    const b = groupWork([user(), one, two], none)[1]
    const more = groupWork([user(), one, two, three], none)[1]
    expect(a && b && samePart(a, b)).toBe(true)
    expect(a && more && samePart(a, more)).toBe(false)
  })
})
