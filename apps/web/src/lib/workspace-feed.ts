import {
  AppView,
  ConversationActivity,
  ConversationView,
  OrganizeReceipt,
  PersonaInvocationView,
  PersonaView,
  TopicView,
  WorkspaceChange,
  type WorkspaceSnapshot,
} from '@goblin/contracts'
import { Option, Schema } from 'effect'
import { type PiEventSource, type ReconnectScheduler, browserScheduler, reconnectDelay } from './conversation-stream.ts'

/**
 * The owner's conversations, oldest first, what each one that is not idle is doing, and their kept Apps, oldest first;
 * from a server that has them, the Topics and Personas (absent from one without), the Persona answers still on their
 * way and the latest organizing receipts, newest first.
 */
export type WorkspaceState = {
  readonly conversations: readonly ConversationView[]
  readonly activity: ReadonlyMap<string, ConversationActivity>
  readonly apps: readonly AppView[]
  readonly topics?: readonly TopicView[]
  readonly personas?: readonly PersonaView[]
  readonly invocations?: readonly PersonaInvocationView[]
  readonly receipts?: readonly OrganizeReceipt[]
}

export const EMPTY_WORKSPACE: WorkspaceState = { conversations: [], activity: new Map(), apps: [] }

/** How many settled Persona answers and organizing receipts the state keeps: enough for Activity and Tasks. */
const KEPT = 50

const oldestFirst = (a: ConversationView, b: ConversationView) =>
  a.createdAt - b.createdAt || Number(a.id) - Number(b.id)

/** The workspace as the feed's snapshot describes it. */
export function fromSnapshot(snapshot: WorkspaceSnapshot): WorkspaceState {
  const busy = snapshot.activity.filter(({ state }) => state !== 'idle')
  const { topics, personas, invocations, receipts } = snapshot
  return {
    conversations: snapshot.conversations.toSorted(oldestFirst),
    activity: new Map(busy.map((activity) => [activity.id, activity])),
    apps: snapshot.apps.toSorted(byId),
    ...(topics !== undefined && { topics: topics.toSorted(byNumber) }),
    ...(personas !== undefined && { personas: personas.toSorted(byNumber) }),
    ...(invocations !== undefined && { invocations }),
    ...(receipts !== undefined && { receipts: receipts.toSorted(newestReceipt).slice(0, KEPT) }),
  }
}

const byNumber = (a: { readonly id: number }, b: { readonly id: number }) => a.id - b.id
const newestReceipt = (a: OrganizeReceipt, b: OrganizeReceipt) => b.at - a.at
const sameInvocation = (a: PersonaInvocationView, b: PersonaInvocationView) =>
  a.operationId === b.operationId && a.persona === b.persona

/** `items` with `item` in place of the one `same` matches, or added, in `order`. */
function upsertBy<T>(items: readonly T[], item: T, same: (a: T, b: T) => boolean, order: (a: T, b: T) => number) {
  const index = items.findIndex((each) => same(each, item))
  return index === -1 ? [...items, item].toSorted(order) : items.with(index, item)
}

/** Whether an invocation is still on its way: pending, or a Persona answering now. */
export const answering = (invocation: PersonaInvocationView): boolean =>
  invocation.state === 'pending' || invocation.state === 'running'

/** The invocations kept: every one still on its way, and the newest settled ones. */
const keptInvocations = (invocations: readonly PersonaInvocationView[]) => {
  const settled = invocations.filter((each) => !answering(each))
  const dropped = new Set(settled.toSorted((a, b) => b.createdAt - a.createdAt).slice(KEPT))
  return dropped.size === 0 ? invocations : invocations.filter((each) => !dropped.has(each))
}

const same = <T extends { readonly id: unknown }>(a: T, b: T) => a.id === b.id

/** The Topic, Persona, invocation and receipt changes of a batch, applied in order. */
function organizing(state: WorkspaceState, change: WorkspaceChange): WorkspaceState {
  if (change.type === 'topic') return { ...state, topics: upsertBy(state.topics ?? [], change.topic, same, byNumber) }
  if (change.type === 'persona')
    return { ...state, personas: upsertBy(state.personas ?? [], change.persona, same, byNumber) }
  if (change.type === 'invocation') {
    const next = upsertBy(state.invocations ?? [], change.invocation, sameInvocation, (a, b) => a.order - b.order)
    return { ...state, invocations: keptInvocations(next) }
  }
  if (change.type === 'receipt')
    return { ...state, receipts: upsertBy(state.receipts ?? [], change.receipt, same, newestReceipt).slice(0, KEPT) }
  return state
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
  let next: WorkspaceState = state
  let { conversations, apps } = state
  const activity = new Map(state.activity)
  for (const change of changes) {
    if (change.type === 'activity') {
      if (change.activity.state === 'idle') activity.delete(change.activity.id)
      else activity.set(change.activity.id, change.activity)
    } else if (change.type === 'app') apps = upsert(apps, change.app, byId)
    else if (change.type === 'app-removed') apps = apps.filter((app) => app.id !== change.id)
    else if (change.type === 'conversation') conversations = upsert(conversations, change.conversation, oldestFirst)
    // Home changes are read by their own view, not this state.
    else next = organizing(next, change)
  }
  return { ...next, conversations, activity, apps }
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
  Schema.Struct({
    conversations: Items,
    activity: Items,
    apps: Items,
    topics: Schema.optional(Items),
    personas: Schema.optional(Items),
    invocations: Schema.optional(Items),
    receipts: Schema.optional(Items),
  }),
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
  const { topics, personas, invocations, receipts } = frame
  return {
    conversations: readable(frame.conversations, decodeConversation),
    activity: readable(frame.activity, decodeActivity),
    apps: readable(frame.apps, decodeApp),
    ...(topics !== undefined && { topics: readable(topics, Schema.decodeUnknownOption(TopicView)) }),
    ...(personas !== undefined && { personas: readable(personas, Schema.decodeUnknownOption(PersonaView)) }),
    ...(invocations !== undefined && {
      invocations: readable(invocations, Schema.decodeUnknownOption(PersonaInvocationView)),
    }),
    ...(receipts !== undefined && { receipts: readable(receipts, Schema.decodeUnknownOption(OrganizeReceipt)) }),
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
