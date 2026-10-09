import { describe, expect, it } from 'vitest'
import { type AppView, type ConversationView, PersonaInvocationView } from '@goblin/contracts'
import { Schema } from 'effect'
import { delegates, needsYou, personaTasks, railCounts, threadList, unreadChats } from '../src/lib/rail.ts'

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
  view('1', { kind: 'main', parent: undefined, lastReplyAt: 90, readAt: 10 }),
  view('5', { lastReplyAt: 50, readAt: 60 }),
  view('6', { lastReplyAt: 70, readAt: 10, attention: [{ kind: 'question', since: 40, label: 'Which date?' }] }),
  view('7', { closedAt: 5, lastReplyAt: 99 }),
  view('8', { kind: 'subagent' }),
  view('9', { kind: 'subagent', closedAt: 9, closedBy: 'done', attention: [{ kind: 'grant', since: 1 }] }),
  view('10', { kind: 'subagent', lastReplyAt: 95, attention: [{ kind: 'approval', since: 20 }] }),
]
const app = (id: string, trouble: boolean): AppView => ({
  id,
  conversation: '1',
  title: `App ${id}`,
  createdAt: Number(id),
  source: {
    kind: 'agent',
    name: `app-${id}`,
    release: 'r_1',
    version: 1,
    revision: 0,
    jobs: trouble
      ? [
          {
            action: 'refresh',
            every: '1d',
            at: null,
            nextAt: 9,
            lastAt: 1,
            status: 'failed',
            error: 'timeout',
            failures: 3,
            paused: 'failures',
          },
        ]
      : [],
  },
})
const invocation = (persona: number, state: PersonaInvocationView['state'], createdAt: number) =>
  Schema.decodeUnknownSync(PersonaInvocationView)({
    operationId: 'op',
    persona,
    revision: 1,
    chat: '1',
    order: persona,
    state,
    createdAt,
  })

describe('the rail pages', () => {
  it('lists threads unread first, then read, newest first, and the closed apart', () => {
    const list = threadList(VIEWS)
    expect(list.unread.map(({ id }) => id)).toEqual(['6'])
    expect(list.read.map(({ id }) => id)).toEqual(['5'])
    expect(list.closed.map(({ id }) => id)).toEqual(['7'])
  })

  it('collects what needs the owner across chats, oldest first, then the agent apps in trouble', () => {
    const needs = needsYou(VIEWS, [app('2', true), app('3', false)])
    expect(
      needs.map((need) => (need.kind === 'app' ? `app ${need.app.id}` : `${need.chat.id} ${need.attention.kind}`)),
    ).toEqual(['10 approval', '6 question', 'app 2'])
  })

  it('lists the unread chats newest first, channels and threads, never a subagent or a closed chat', () => {
    expect(unreadChats(VIEWS).map(({ id }) => id)).toEqual(['1', '6'])
  })

  it('puts Delegates at work first, then the open ones, and the finished apart', () => {
    const work = delegates(VIEWS, new Map([['8', { id: '8', state: 'working' as const, since: 1 }]]))
    expect(work.active.map(({ id }) => id)).toEqual(['8', '10'])
    expect(work.finished.map(({ id }) => id)).toEqual(['9'])
  })

  it('puts Persona answers on their way first, in order, then the settled ones newest first', () => {
    const tasks = personaTasks([
      invocation(1, 'answered', 5),
      invocation(3, 'pending', 9),
      invocation(2, 'running', 9),
      invocation(4, 'failed', 7),
    ])
    expect(tasks.map(({ persona }) => persona)).toEqual([2, 3, 4, 1])
  })

  it('counts unread threads, what needs the owner and the work going on, for the rail', () => {
    const counts = railCounts(
      VIEWS,
      [app('2', true)],
      new Map([['8', { id: '8', state: 'working' as const, since: 1 }]]),
      [invocation(1, 'running', 1), invocation(2, 'answered', 1)],
    )
    expect(counts).toEqual({ threads: 1, activity: 3, tasks: 2 })
  })
})
