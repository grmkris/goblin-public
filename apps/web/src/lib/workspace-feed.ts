import {
  type ConversationActivity,
  type ConversationView,
  WorkspaceChange,
  WorkspaceSnapshot,
} from '@purrable/contracts'
import { Schema } from 'effect'
import { type PiEventSource, type ReconnectScheduler, browserScheduler, reconnectDelay } from './conversation-stream.ts'

/** The owner's conversations, oldest first, and what each one that is not idle is doing. */
export type WorkspaceState = {
  readonly conversations: readonly ConversationView[]
  readonly activity: ReadonlyMap<string, ConversationActivity>
}

export const EMPTY_WORKSPACE: WorkspaceState = { conversations: [], activity: new Map() }

const oldestFirst = (a: ConversationView, b: ConversationView) =>
  a.createdAt - b.createdAt || Number(a.id) - Number(b.id)

/** The workspace as the feed's snapshot describes it. */
export function fromSnapshot(snapshot: WorkspaceSnapshot): WorkspaceState {
  const busy = snapshot.activity.filter(({ state }) => state !== 'idle')
  return {
    conversations: snapshot.conversations.toSorted(oldestFirst),
    activity: new Map(busy.map((activity) => [activity.id, activity])),
  }
}

/**
 * The workspace after `changes`, in order: a conversation replaces the one with its id (a new one joins in order of
 * creation), and an activity replaces what its conversation was doing (idle drops it).
 */
export function applyChanges(state: WorkspaceState, changes: readonly WorkspaceChange[]): WorkspaceState {
  let { conversations } = state
  const activity = new Map(state.activity)
  for (const change of changes) {
    if (change.type === 'activity') {
      if (change.activity.state === 'idle') activity.delete(change.activity.id)
      else activity.set(change.activity.id, change.activity)
      continue
    }
    const view = change.conversation
    const index = conversations.findIndex(({ id }) => id === view.id)
    conversations = index === -1 ? [...conversations, view].toSorted(oldestFirst) : conversations.with(index, view)
  }
  return { conversations, activity }
}

/** What a conversation's agent is doing now. */
export const activityState = (state: WorkspaceState, id: string): ConversationActivity['state'] =>
  state.activity.get(id)?.state ?? 'idle'

const decodeSnapshot = Schema.decodeUnknownSync(WorkspaceSnapshot)
const decodeChanges = Schema.decodeUnknownSync(Schema.Array(WorkspaceChange))

/**
 * The workspace feed for the browser: one SSE stream, a snapshot on every (re)connect, then changes. A dropped or
 * unreadable stream reconnects on its own with backoff and starts again from a fresh snapshot.
 */
export class WorkspaceFeedConnection {
  #source: PiEventSource | undefined
  #state: WorkspaceState | undefined
  #cancelRetry: (() => void) | undefined
  #attempt = 0
  #disposed = false

  constructor(
    readonly events: () => PiEventSource,
    readonly publish: (state: WorkspaceState) => void,
    readonly report: (problem: string | undefined) => void,
    readonly scheduler: ReconnectScheduler = browserScheduler,
  ) {}

  connect(): void {
    this.#detach()
    this.#disposed = false
    const source = this.events()
    this.#source = source
    source.addEventListener('snapshot', (event) =>
      this.#receive(source, () => fromSnapshot(decodeSnapshot(JSON.parse(event.data)))),
    )
    source.addEventListener('change', (event) =>
      this.#receive(source, () =>
        this.#state === undefined ? undefined : applyChanges(this.#state, decodeChanges(JSON.parse(event.data))),
      ),
    )
    source.onError(() => {
      if (this.#source === source) this.#retry('Connection interrupted')
    })
  }

  dispose(): void {
    this.#disposed = true
    this.#detach()
  }

  #detach(): void {
    this.#cancelRetry?.()
    this.#cancelRetry = undefined
    this.#source?.close()
    this.#source = undefined
  }

  #receive(source: PiEventSource, next: () => WorkspaceState | undefined): void {
    if (this.#source !== source) return
    try {
      const state = next()
      if (state === undefined) return
      this.#state = state
      this.#attempt = 0
      this.publish(state)
      this.report(undefined)
    } catch {
      this.#retry('Workspace data could not be read')
    }
  }

  #retry(problem: string): void {
    this.#detach()
    if (this.#disposed) return
    this.report(problem)
    const delay = reconnectDelay(this.#attempt)
    this.#attempt += 1
    this.#cancelRetry = this.scheduler.schedule(() => this.connect(), delay)
  }
}
