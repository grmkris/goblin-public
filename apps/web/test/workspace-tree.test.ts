import { describe, expect, it } from 'vitest'
import type { AppView, ConversationActivity, ConversationView } from '@purrable/contracts'
import {
  type TreeNode,
  appNames,
  buildTree,
  foldApps,
  isUnread,
  pathOf,
  railItems,
  rowStatus,
} from '../src/lib/workspace-tree.ts'

const view = (id: string, extra: Partial<ConversationView> = {}): ConversationView => ({
  id,
  kind: 'thread',
  parent: '1',
  keepOpen: false,
  replies: 0,
  createdAt: Number(id),
  ...extra,
})
const closed = { closedAt: 50, closedBy: 'owner' } as const
const MAIN = view('1', { kind: 'main', createdAt: 0, parent: undefined })
const VIEWS = [
  MAIN,
  view('2', { kind: 'subagent' }),
  view('3', { kind: 'subagent', parent: '2' }),
  view('4', { parent: '3' }),
  view('5'),
  view('6', { parent: '5' }),
  view('7', { kind: 'subagent', parent: '6' }),
  view('8', closed),
  view('9', { parent: '5', ...closed }),
  view('10'),
]
const ids = (nodes: readonly TreeNode[]) => nodes.map(({ view: { id } }) => id)
const working = (id: string, since = 100): [string, ConversationActivity] => [id, { id, state: 'working', since }]

describe('the sidebar tree', () => {
  it('nests subagents under main at any depth, threads in their own group, and folds the closed away', () => {
    const tree = buildTree(VIEWS)
    expect(tree.main?.view.id).toBe('1')
    expect(ids(tree.main?.children ?? [])).toEqual(['2'])
    expect(ids(tree.main?.children[0]?.children ?? [])).toEqual(['3'])
    expect(ids(tree.main?.children[0]?.children[0]?.children ?? [])).toEqual(['4'])
    expect(ids(tree.threads)).toEqual(['10', '5'])
    expect(ids(tree.threads[1]?.children ?? [])).toEqual(['6'])
    expect(ids(tree.threads[1]?.closed ?? [])).toEqual(['9'])
    expect(ids(tree.threads[1]?.children[0]?.children ?? [])).toEqual(['7'])
    expect(ids(tree.closedThreads)).toEqual(['8'])
  })

  it('ends on a cycle in stored parents instead of recursing forever', () => {
    const tree = buildTree([MAIN, view('5', { parent: '6' }), view('6', { parent: '5' }), view('7')])
    expect(ids(tree.threads)).toEqual(['7'])
  })

  it('names the path from main for the hover card', () => {
    expect(pathOf(VIEWS, '7', ({ id }) => `#${id}`)).toEqual(['#1', '#5', '#6', '#7'])
  })
})

describe('row status', () => {
  it('shows what the agent is doing, work going on below, and unread replies', () => {
    const tree = buildTree(VIEWS)
    const thread = tree.threads[1]
    if (thread === undefined) throw new Error('fixture')
    expect(rowStatus(thread, new Map([working('7')]))).toEqual({ state: 'idle', below: true, unread: false })
    expect(rowStatus(thread, new Map([working('5', 9)]))).toEqual({
      state: 'working',
      since: 9,
      below: false,
      unread: false,
    })
  })

  it('counts replies after the read mark, and any replies without one, as unread', () => {
    expect(isUnread(view('5', { lastReplyAt: 20 }))).toBe(true)
    expect(isUnread(view('5', { lastReplyAt: 20, readAt: 20 }))).toBe(false)
    expect(isUnread(view('5', { lastReplyAt: 21, readAt: 20 }))).toBe(true)
    expect(isUnread(view('5'))).toBe(false)
  })
})

const app = (id: string, conversation: string, extra: Partial<AppView> = {}): AppView => ({
  id,
  conversation,
  callId: `call-${id}`,
  serverId: 'board',
  tool: 'show',
  uri: 'ui://board/app.html',
  title: `Board ${id}`,
  createdAt: Number(id),
  ...extra,
})

describe('Apps in the sidebar tree', () => {
  it('lists each open App under its conversation, newest first, at any depth, and leaves closed ones out', () => {
    const tree = buildTree(VIEWS, [app('1', '1'), app('2', '6'), app('3', '6', { closedAt: 9 }), app('4', '99')])
    expect(tree.main?.apps.map(({ app: { id } }) => id)).toEqual(['1'])
    const thread = tree.threads.find(({ view: { id } }) => id === '5')
    expect(thread?.children[0]?.apps.map(({ app: { id } }) => id)).toEqual(['2'])
    const rail = railItems(
      tree,
      new Map(),
      () => false,
      (id) => id !== '1',
    )
    expect(rail.apps.map(({ app: { id } }) => id)).toEqual(['2'])
  })
  it('numbers Apps of one title within a conversation, closed ones counted, so names never shift', () => {
    const board = { title: 'Board' }
    const names = appNames([
      app('3', '1', board),
      app('1', '1', board),
      app('2', '1', { ...board, closedAt: 5 }),
      app('4', '6', board),
      app('5', '1', { title: 'Map' }),
    ])
    expect(Object.fromEntries(names)).toEqual({
      1: 'Board (1)',
      2: 'Board (2)',
      3: 'Board (3)',
      4: 'Board',
      5: 'Map',
    })
  })
  it('shows the Apps open as pages and the newest up to three, and folds the rest', () => {
    const rows = ['9', '8', '7', '6', '5'].map((id) => ({ app: app(id, '1'), name: id }))
    const folded = foldApps(rows, (id) => id === '5')
    expect(folded.shown.map(({ name }) => name)).toEqual(['9', '8', '5'])
    expect(folded.folded.map(({ name }) => name)).toEqual(['7', '6'])
    expect(foldApps(rows.slice(0, 2), () => false).folded).toEqual([])
  })
})

describe('the folded rail', () => {
  it('keeps main, then the active conversations of each group in tree order', () => {
    const tree = buildTree([...VIEWS.filter(({ id }) => id !== '10'), view('10', { lastReplyAt: 5 })])
    const rail = railItems(tree, new Map([working('7')]), (id) => id === '4')
    expect(ids(rail.main)).toEqual(['1', '4'])
    expect(ids(rail.threads)).toEqual(['10', '5', '6', '7'])
    expect(ids(railItems(tree, new Map(), () => false).threads)).toEqual(['10'])
  })
})
