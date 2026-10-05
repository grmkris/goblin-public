import { describe, expect, it } from 'vitest'
import type { ThreadView } from '@purrable/contracts'
import {
  branchPoints,
  entryOfPart,
  fromEntry,
  relativeTime,
  repliesLabel,
  rootParts,
  threadTree,
  threadsByFork,
} from '../src/lib/threads.ts'

const view = (id: string, extra: Partial<ThreadView> = {}): ThreadView => ({
  id,
  kind: 'thread',
  parent: '1',
  busy: false,
  archived: false,
  createdAt: Number(id),
  ...extra,
})
const MAIN = view('1', { kind: 'main', createdAt: 0 })

describe('the thread list', () => {
  it('puts main first, live threads newest first with their subagents, and archived ones apart', () => {
    const tree = threadTree([
      MAIN,
      view('5'),
      view('9'),
      view('6', { kind: 'subagent', parent: '5' }),
      view('7', { kind: 'subagent', parent: '1' }),
      view('8', { archived: true }),
    ])
    expect(tree.main?.thread.id).toBe('1')
    expect(tree.main?.subagents.map(({ id }) => id)).toEqual(['7'])
    expect(tree.threads.map(({ thread }) => thread.id)).toEqual(['9', '5'])
    expect(tree.threads[1]?.subagents.map(({ id }) => id)).toEqual(['6'])
    expect(tree.archived.map(({ id }) => id)).toEqual(['8'])
  })
})

describe('threads in main', () => {
  it('groups live threads under the entry they branched from, newest first', () => {
    const byFork = threadsByFork([
      MAIN,
      view('5', { forkEntry: 40 }),
      view('9', { forkEntry: 40 }),
      view('6', { forkEntry: 12 }),
      view('7'),
      view('8', { forkEntry: 40, archived: true }),
      view('10', { kind: 'subagent', forkEntry: 40 }),
    ])
    expect(byFork.get(40)?.map(({ id }) => id)).toEqual(['9', '5'])
    expect(byFork.get(12)?.map(({ id }) => id)).toEqual(['6'])
    expect(byFork.size).toBe(2)
  })

  it('branches only from what the owner or the agent said, never from a note shared into main', () => {
    const points = branchPoints([
      { id: 3, kind: 'pi.user' },
      { id: 4, kind: 'pi.assistant' },
      { id: 5, kind: 'app.shared' },
      { id: 6, kind: 'pi.tool' },
      { id: 'x', kind: 'pi.user' },
    ])
    expect([...points]).toEqual([3, 4])
  })

  it('shows a branched thread from the message it branched at, without the main history before it', () => {
    const messages = [{ id: '3:0' }, { id: '4:0' }, { id: '40:0' }, { id: '41:0' }, { id: '42:1' }]
    expect(fromEntry(messages, 40).map(({ id }) => id)).toEqual(['40:0', '41:0', '42:1'])
    expect(entryOfPart('42:1:text')).toBe(42)
    expect(entryOfPart('tool:abc')).toBeUndefined()
  })

  it('shows the root message of a thread by its words, not its thoughts or tool calls', () => {
    const root = rootParts(
      [
        { kind: 'user', id: '40:0', text: 'hello' },
        { kind: 'reasoning', id: '41:0:reasoning', text: 'hm', live: false },
        { kind: 'text', id: '41:0:text', text: 'hi', live: false },
        { kind: 'text', id: '42:0:text', text: 'later', live: false },
      ],
      41,
    )
    expect(root.map(({ id }) => id)).toEqual(['41:0:text'])
  })

  it('counts replies and says when the last one was written', () => {
    expect([0, 1, 3].map(repliesLabel)).toEqual(['No replies yet', '1 reply', '3 replies'])
    const now = 1_000_000
    expect(relativeTime(now - 10, now)).toBe('just now')
    expect(relativeTime(now - 120, now)).toBe('2 minutes ago')
    expect(relativeTime(now - 3 * 3600, now)).toBe('3 hours ago')
    expect(relativeTime(now - 86_400, now)).toBe('yesterday')
    expect(relativeTime(now - 14 * 86_400, now)).toBe('2 weeks ago')
    expect(relativeTime(now - 400 * 86_400, now)).toBe('last year')
    expect(relativeTime(now + 30, now)).toBe('just now')
  })
})
