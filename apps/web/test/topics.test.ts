import { describe, expect, it } from 'vitest'
import { type ConversationView, EVERYTHING, type TopicView } from '@goblin/contracts'
import { PERSONAL, channelOf, channels, isChannel, topicOfChannel, topicThreads, topicsOf } from '../src/lib/topics.ts'

const topic = (id: number, name: string, conversation: string, extra: Partial<TopicView> = {}): TopicView => ({
  id,
  name,
  conversation,
  searchExcluded: false,
  revision: 1,
  setup: EVERYTHING,
  createdBy: 'owner',
  createdAt: id,
  ...extra,
})
const view = (id: string, extra: Partial<ConversationView> = {}): ConversationView => ({
  id,
  kind: 'thread',
  parent: '1',
  keepOpen: false,
  replies: 1,
  createdAt: Number(id),
  ...extra,
})
const TOPICS = [
  topic(3, 'zebra', '30'),
  topic(1, 'Personal', '1', { personal: true }),
  topic(2, 'Japan', '20'),
  topic(4, 'Taxes', '40', { archivedAt: 9 }),
]

describe('Topics as channels', () => {
  it('is Personal alone on a server without Topics', () => {
    expect(topicsOf([])).toEqual([PERSONAL])
    expect(channels([]).active.map(({ name }) => name)).toEqual(['Personal'])
  })

  it('lists Personal first, then by name whatever the case, and the archived apart', () => {
    const { active, archived } = channels(TOPICS)
    expect(active.map(({ name }) => name)).toEqual(['Personal', 'Japan', 'zebra'])
    expect(archived.map(({ name }) => name)).toEqual(['Taxes'])
  })

  it("finds a channel's Topic", () => {
    expect(topicOfChannel('20', TOPICS)?.name).toBe('Japan')
    expect(topicOfChannel('1', [])).toBe(PERSONAL)
    expect(topicOfChannel('99', TOPICS)).toBeUndefined()
  })
})

describe('the channel a chat belongs to', () => {
  const views = [
    view('1', { kind: 'main', parent: undefined }),
    view('20', { kind: 'main', conversation: true, parent: undefined, topic: 2 }),
    view('5'),
    view('6', { parent: '5' }),
    view('7', { kind: 'subagent', parent: '6' }),
    view('8', { parent: '20', topic: 2 }),
    view('9', { parent: '8' }),
    view('10', { parent: '11' }),
    view('11', { parent: '10' }),
  ]
  it('is the chat itself for a channel', () => {
    expect(isChannel(views[1] ?? view('0'))).toBe(true)
    expect(channelOf('20', views, TOPICS)).toBe('20')
    expect(channelOf('1', views, TOPICS)).toBe('1')
  })

  it('walks up threads and subagents to their channel, or takes their Topic', () => {
    expect(channelOf('7', views, TOPICS)).toBe('1')
    expect(channelOf('9', views, TOPICS)).toBe('20')
    expect(channelOf('8', views, [])).toBe('20')
  })

  it("ends a loop in stored parents at Personal's channel, and an unknown chat there too", () => {
    expect(channelOf('10', views, TOPICS)).toBe('1')
    expect(channelOf('404', views, TOPICS)).toBe('1')
  })
})

describe("a Topic's threads in the sidebar", () => {
  const views = [
    view('1', { kind: 'main', parent: undefined }),
    view('20', { kind: 'main', conversation: true, parent: undefined, topic: 2 }),
    view('5', { lastReplyAt: 50, readAt: 10 }),
    view('6', { parent: '5', lastReplyAt: 60, readAt: 60 }),
    view('7', { kind: 'subagent', parent: '1' }),
    view('8', { parent: '20', topic: 2, lastReplyAt: 80 }),
    view('9', { closedAt: 3, lastReplyAt: 99 }),
    view('10'),
  ]
  it('lists the threads at work, unread or recently opened, newest first, under their own channel', () => {
    const working = { '7': { id: '7', state: 'working' as const, since: 1 } }
    const listed = topicThreads('1', views, TOPICS, working, new Set(['6']))
    expect(listed.map(({ id }) => id)).toEqual(['6', '5', '7'])
    expect(topicThreads('20', views, TOPICS, {}, new Set()).map(({ id }) => id)).toEqual(['8'])
  })

  it('never lists a closed thread, and lists at most five', () => {
    expect(topicThreads('1', views, TOPICS, {}, new Set(['9'])).map(({ id }) => id)).toEqual(['5'])
    const many = [
      views[0] ?? view('1'),
      ...Array.from({ length: 8 }, (_, n) => view(String(30 + n), { lastReplyAt: n + 1 })),
    ]
    expect(topicThreads('1', many, [], {}, new Set()).map(({ id }) => id)).toEqual(['37', '36', '35', '34', '33'])
  })
})
