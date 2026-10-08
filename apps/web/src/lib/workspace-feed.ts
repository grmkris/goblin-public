import {
  AppView,
  ConversationActivity,
  ConversationView,
  WorkspaceChange,
  type WorkspaceSnapshot,
} from '@goblin/contracts'
import { Option, Schema } from 'effect'
import { type PiEventSource, type ReconnectScheduler, browserScheduler, reconnectDelay } from './conversation-stream.ts'

/** The owner's conversations, oldest first, what each one that is not idle is doing, and their kept Apps, oldest first. */
export type WorkspaceState = {
  readonly conversations: readonly ConversationView[]
  readonly activity: ReadonlyMap<string, ConversationActivity>
  readonly apps: readonly AppView[]
}

export const EMPTY_WORKSPACE: WorkspaceState = { conversations: [], activity: new Map(), apps: [] }

const oldestFirst = (a: ConversationView, b: ConversationView) =>
  a.createdAt - b.createdAt || Number(a.id) - Number(b.id)

/** The workspace as the feed's snapshot describes it. */
export function fromSnapshot(snapshot: WorkspaceSnapshot): WorkspaceState {
  const busy = snapshot.activity.filter(({ state }) => state !== 'idle')
  return {
    conversations: snapshot.conversations.toSorted(oldestFirst),
    activity: new Map(busy.map((activity) => [activity.id, activity])),
    apps: snapshot.apps.toSorted(byId),
  }
}

const byId = (a: AppView, b: AppView) => Number(a.id) - Number(b.id)
/** `items` with `item` in place of the one with its id, or added in `order`. */
function upsert<T extends { readonly id: string }>(items: readonly T[], item: T, order: (a: T, b: T) => number) {
  const index = items.findIndex(({ id }) => id === item.id)
  return index === -1 ? [...items, item].toSorted(order) : items.with(index, item)
}

/**
 * The workspace after `changes`, in order: a conversation or App replaces the one with its id (a new one joins in
 * order of creation), a removed App goes, and an activity replaces what its conversation was doing (idle drops it).
 */
export function applyChanges(state: WorkspaceState, changes: readonly WorkspaceChange[]): WorkspaceState {
  let { conversations, apps } = state
  const activity = new Map(state.activity)
  for (const change of changes) {
    if (change.type === 'activity') {
      if (change.activity.state === 'idle') activity.delete(change.activity.id)
      else activity.set(change.activity.id, change.activity)
    } else if (change.type === 'app') apps = upsert(apps, change.app, byId)
    else if (change.type === 'app-removed') apps = apps.filter((app) => app.id !== change.id)
    else if (change.type === 'home') continue
    else conversations = upsert(conversations, change.conversation, oldestFirst)
  }
  return { conversations, activity, apps }
}

/**
 * `state` with the Apps the owner just kept or closed shown as they will be, until the feed itself shows them so: a
 * change the feed sends meanwhile about something else must not bring a closed App back (and load it again). `settled`
 * are the Apps the feed now agrees on, open or closed, which need no overlay any more.
 */
export function withPendingApps(
  state: WorkspaceState,
  pending: ReadonlyMap<string, AppView>,
): { readonly state: WorkspaceState; readonly settled: readonly string[] } {
  const settled: string[] = []
  const changes: WorkspaceChange[] = []
  for (const [id, app] of pending) {
    const shown = state.apps.find((candidate) => candidate.id === id)
    if (shown !== undefined && (shown.closedAt === undefined) === (app.closedAt === undefined)) settled.push(id)
    else changes.push({ type: 'app', app })
  }
  return { state: changes.length === 0 ? state : applyChanges(state, changes), settled }
}

/** What a conversation's agent is doing now. */
export const activityState = (state: WorkspaceState, id: string): ConversationActivity['state'] =>
  state.activity.get(id)?.state ?? 'idle'

const Items = Schema.Array(Schema.Unknown)
const decodeSnapshotFrame = Schema.decodeUnknownSync(
  Schema.Struct({ conversations: Items, activity: Items, apps: Items }),
)
const decodeChangeFrame = Schema.decodeUnknownSync(Items)
const decodeConversation = Schema.decodeUnknownOption(ConversationView)
const decodeActivity = Schema.decodeUnknownOption(ConversationActivity)
const decodeApp = Schema.decodeUnknownOption(AppView)
const decodeChange = Schema.decodeUnknownOption(WorkspaceChange)

/** The items `decode` reads, in order: one this tab cannot read (a newer server's kind or field) is skipped. */
const readable = <A>(items: readonly unknown[], decode: (item: unknown) => Option.Option<A>): A[] =>
  items.flatMap((item) => Option.toArray(decode(item)))

/**
 * A snapshot frame: its shape must hold, but each conversation, activity and App is read on its own, so a server newer
 * than this tab never stops the feed. A frame of another shape throws, and the connection starts again.
 */
export function decodeSnapshot(data: unknown): WorkspaceSnapshot {
  const frame = decodeSnapshotFrame(data)
  return {
    conversations: readable(frame.conversations, decodeConversation),
    activity: readable(frame.activity, decodeActivity),
    apps: readable(frame.apps, decodeApp),
  }
}

/** A change frame: a list, of which each change this tab can read applies and any other is skipped. */
export const decodeChanges = (data: unknown): WorkspaceChange[] => readable(decodeChangeFrame(data), decodeChange)

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
