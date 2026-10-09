import { describe, expect, it } from 'vitest'
import type { ConversationView } from '@goblin/contracts'
import { draftFrom, panelItems, panelSearch, parsePanelSearch } from '../src/lib/panel.ts'

const view = (id: string, extra: Partial<ConversationView> = {}): ConversationView => ({
  id,
  kind: 'thread',
  parent: '1',
  keepOpen: false,
  replies: 1,
  createdAt: Number(id),
  ...extra,
})
const VIEWS = [
  view('1', { kind: 'main', parent: undefined }),
  view('5'),
  view('6', { parent: '5' }),
  view('7', { kind: 'subagent', parent: '6' }),
  view('9', { parent: '10' }),
  view('10', { parent: '9' }),
]

describe("the thread panel's search", () => {
  it('keeps thread ids as numbers, a stack of ids and a draft, and drops anything else', () => {
    expect(parsePanelSearch({ thread: 12, stack: '5-6', reply: '1-34' })).toEqual({
      thread: 12,
      stack: '5-6',
      reply: '1-34',
    })
    expect(parsePanelSearch({ thread: '12', stack: 5 })).toEqual({ thread: 12, stack: '5' })
    expect(parsePanelSearch({ reply: 'new' })).toEqual({ reply: 'new' })
    expect(parsePanelSearch({ thread: 'x', stack: '5-6', reply: '<b>' })).toEqual({})
    expect(parsePanelSearch({ thread: -3, reply: 4 })).toEqual({})
  })
})

describe('what the panel holds', () => {
  it('is nothing without a thread or a draft', () => {
    expect(panelItems({}, '1', VIEWS)).toEqual([])
  })

  it('stacks a nested thread on the threads it sits in, from its parents, so back goes to the one it started in', () => {
    expect(panelItems({ thread: 7 }, '1', VIEWS)).toEqual([
      { kind: 'thread', id: '5' },
      { kind: 'thread', id: '6' },
      { kind: 'thread', id: '7' },
    ])
    expect(panelItems({ thread: 5 }, '1', VIEWS)).toEqual([{ kind: 'thread', id: '5' }])
  })

  it('takes an explicit stack over the parents, and ends a loop in stored parents', () => {
    expect(panelItems({ thread: 7, stack: '6' }, '1', VIEWS).map((item) => item.kind === 'thread' && item.id)).toEqual([
      '6',
      '7',
    ])
    expect(panelItems({ thread: 9 }, '1', VIEWS).map((item) => item.kind === 'thread' && item.id)).toEqual(['10', '9'])
  })

  it('puts a draft on top: a reply to a message, or a new thread', () => {
    const items = panelItems({ thread: 5, reply: '5-40' }, '1', VIEWS)
    expect(items.at(-1)).toEqual({ kind: 'reply', conversation: '5', entry: 40 })
    expect(draftFrom(items.at(-1) ?? { kind: 'new' })).toEqual({ conversation: '5', entry: 40 })
    expect(panelItems({ reply: 'new' }, '1', VIEWS)).toEqual([{ kind: 'new' }])
    expect(draftFrom({ kind: 'new' })).toBeUndefined()
  })

  it('writes back the search that shows a stack, naming the stack only where the parents would not', () => {
    expect(panelSearch(panelItems({ thread: 7 }, '1', VIEWS), '1', VIEWS)).toEqual({ thread: 7 })
    expect(panelSearch(panelItems({ thread: 7 }, '1', VIEWS).slice(0, -1), '1', VIEWS)).toEqual({ thread: 6 })
    expect(
      panelSearch(
        [
          { kind: 'thread', id: '5' },
          { kind: 'thread', id: '7' },
        ],
        '1',
        VIEWS,
      ),
    ).toEqual({
      thread: 7,
      stack: '5',
    })
    expect(panelSearch([{ kind: 'reply', conversation: '1', entry: 3 }], '1', VIEWS)).toEqual({ reply: '1-3' })
    expect(panelSearch([], '1', VIEWS)).toEqual({})
  })
})
