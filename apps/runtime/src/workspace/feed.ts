import type { TaskGraph } from '@earendil-works/pi-durable'
import type { ConversationActivity, WorkspaceChange } from '@goblin/contracts'
import * as Stream from 'effect/Stream'
import { SUBAGENT_RELAY } from '../pi/subagent-relay.ts'
import type { WorkspaceEvent } from './service.ts'

export type Busy = 'working' | 'waiting'

/**
 * What each conversation is doing, from Pi's live tasks: `working` while it has ordinary (non-background) work, else
 * `waiting` while a task waits there on a subagent's answer. Background housekeeping (memory, routines) is neither.
 * A conversation not in the map is idle.
 */
export function activityOf(graph: TaskGraph): ReadonlyMap<string, Busy> {
  const states = new Map<string, Busy>()
  for (const task of Object.values(graph.tasks)) {
    const id = String(task.conversationId)
    if (!task.background) states.set(id, 'working')
    else if (task.kind === SUBAGENT_RELAY && states.get(id) !== 'working') states.set(id, 'waiting')
  }
  return states
}

/** What one move of the activity changed: the changes to send, and the conversations that went idle. */
export type ActivityMove = { readonly changes: readonly WorkspaceChange[]; readonly settled: readonly string[] }

/**
 * Moves `current` (each busy conversation's activity, by chat id) to `next` at `now`, in place, and answers what
 * changed. A conversation missing from `next` went idle: it is described again too, since its run wrote replies and
 * may have named it.
 */
export function moveActivity(
  current: Map<string, ConversationActivity>,
  next: ReadonlyMap<string, Busy>,
  now: number,
): ActivityMove {
  const changes: WorkspaceChange[] = []
  const settled: string[] = []
  for (const [id, state] of next) {
    if (current.get(id)?.state === state) continue
    const activity = { id, state, since: now }
    current.set(id, activity)
    changes.push({ type: 'activity', activity })
  }
  for (const id of current.keys()) {
    if (next.has(id)) continue
    current.delete(id)
    changes.push({ type: 'activity', activity: { id, state: 'idle', since: now } })
    settled.push(id)
  }
  return { changes, settled }
}

/** Comment frames keep an idle stream open through proxies that close silent connections. */
const HEARTBEAT = '25 seconds'

/** The feed as Server-Sent Events: one `event:` frame per event with its JSON `data`, and a comment frame while idle. */
export const sseFrames = <E, R>(events: Stream.Stream<WorkspaceEvent, E, R>): Stream.Stream<Uint8Array, E, R> =>
  events.pipe(
    Stream.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    Stream.merge(
      Stream.tick(HEARTBEAT).pipe(
        Stream.drop(1),
        Stream.map(() => ': ping\n\n'),
      ),
      { haltStrategy: 'left' },
    ),
    Stream.encodeText,
  )
