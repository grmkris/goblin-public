import { describe, expect, it } from 'vitest'
import type { ConversationId, TaskGraph, TaskGraphNode, TaskId } from '@earendil-works/pi-durable'
import { SUBAGENT_RELAY } from '../src/pi/subagent-relay.ts'
import { activityOf } from '../src/workspace/feed.ts'

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
