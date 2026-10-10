import { describe, expect, it } from 'vitest'
import type { ConversationId, TaskGraph, TaskGraphNode, TaskId } from '@earendil-works/pi-durable'
import { SUBAGENT_RELAY } from '../src/pi/subagent-relay.ts'
import type { ConversationActivity } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'
import { activityOf, moveActivity, sseFrames } from '../src/workspace/feed.ts'

/** A live task in conversation `conversation`. SAFETY: Pi ids are plain integers at runtime; the brand only types them. */
const task = (id: number, conversation: number, kind: string, background: boolean): TaskGraphNode => ({
  id: id as TaskId,
  kind,
  conversationId: conversation as ConversationId,
  background,
  abortRequested: false,
  state: { status: 'running', phase: 'run' },
  conversations: [],
})
const graph = (...tasks: TaskGraphNode[]): TaskGraph => ({
  tasks: Object.fromEntries(tasks.map((node) => [String(node.id), node])),
})

describe('what each conversation is doing, from the task graph', () => {
  it('works on ordinary tasks, waits on subagent relays, and ignores background housekeeping', () => {
    const states = activityOf(
      graph(
        task(1, 1, 'goblin.memory-builder', true),
        task(2, 7, 'pi.generation', false),
        task(3, 9, SUBAGENT_RELAY, true),
        task(4, 11, SUBAGENT_RELAY, true),
        task(5, 11, 'pi.generation', false),
      ),
    )
    expect(Object.fromEntries(states)).toEqual({ '7': 'working', '9': 'waiting', '11': 'working' })
  })

  it('is empty when nothing is live', () => {
    expect(activityOf(graph()).size).toBe(0)
  })
})

describe('moving the feed to what the graph shows now', () => {
  it('sends only what changed and names what went idle, keeping the time each state began', () => {
    const current = new Map<string, ConversationActivity>([
      ['1', { id: '1', state: 'working', since: 10 }],
      ['2', { id: '2', state: 'waiting', since: 10 }],
    ])
    const moved = moveActivity(
      current,
      new Map([
        ['1', 'working'],
        ['3', 'waiting'],
      ]),
      20,
    )
    expect(moved.changes).toEqual([
      { type: 'activity', activity: { id: '3', state: 'waiting', since: 20 } },
      { type: 'activity', activity: { id: '2', state: 'idle', since: 20 } },
    ])
    expect(moved.settled).toEqual(['2'])
    expect([...current.values()]).toEqual([
      { id: '1', state: 'working', since: 10 },
      { id: '3', state: 'waiting', since: 20 },
    ])
  })
})

describe('the feed as Server-Sent Events', () => {
  it('writes one event frame per event with its JSON data, and ends with the feed', async () => {
    const frames = await Effect.runPromise(
      Stream.make({ event: 'change' as const, data: [] }).pipe(sseFrames, Stream.decodeText, Stream.runCollect),
    )
    expect(frames.join('')).toBe('event: change\ndata: []\n\n')
  })
})
