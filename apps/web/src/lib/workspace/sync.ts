import { type QueryClient, queryOptions } from '@tanstack/react-query'
import type { AppView, WorkspaceChange, WorkspaceSnapshot } from '@goblin/contracts'
import type { PiEventSource } from '../conversation-stream.ts'
import { reportUnexpected } from '../unexpected.ts'
import { WorkspaceFeedConnection } from './connection.ts'
import { type Cached, staleAfter } from './invalidations.ts'
import { type AppChange, PendingApps } from './pending-apps.ts'
import { EMPTY_WORKSPACE, SLICE_NAMES, type Slice, type Slices, applyChanges, fromSnapshot } from './slices.ts'

/**
 * The workspace in the Query cache: each slice under `['workspace', slice]`, what is wrong with the feed under
 * `['workspace', 'status']`, and `['workspace', 'apps']` the key of the mutations that keep, close or reopen an App.
 */
export const workspaceKeys = {
  all: ['workspace'] as const,
  slice: <K extends Slice>(slice: K) => ['workspace', slice] as const,
  status: ['workspace', 'status'] as const,
  apps: ['workspace', 'apps'] as const,
}

/** A change the server answered the owner with, shown before the feed repeats it. An App's goes through `appAnswered`. */
type AnsweredChange = Exclude<WorkspaceChange, { readonly type: 'app' | 'app-removed' }>

/** A promise settled from outside, once. */
function deferred() {
  let settle: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    settle = resolve
  })
  return { promise, resolve: () => settle?.() }
}

/**
 * The feed's writer into one QueryClient's cache: the snapshot of every (re)connect and the changes after it, each
 * slice set on its own, so a component reading one slice does not render for a change to another. A slice's read waits
 * for the first snapshot, then the feed keeps it current; it is never read from the server on its own.
 *
 * The Apps slice is the feed's Apps (`#feedApps`) with the owner's App changes the feed has not caught up with shown
 * over them (`#pending`), so every write, from the feed or not, shows them.
 */
class WorkspaceSync {
  readonly #client: QueryClient
  #first = deferred()
  #synced = false
  #connection: WorkspaceFeedConnection | undefined
  #feedApps: readonly AppView[] = EMPTY_WORKSPACE.apps
  readonly #pending = new PendingApps()

  constructor(client: QueryClient) {
    this.#client = client
    client.setQueryDefaults(workspaceKeys.all, { staleTime: Infinity, gcTime: Infinity })
  }

  /** Slice `slice` as the feed left it, once its first snapshot is in. */
  async read<K extends Slice>(slice: K): Promise<Slices[K]> {
    await this.#first.promise
    return this.#cached(slice) ?? EMPTY_WORKSPACE[slice]
  }

  /**
   * Every slice from a snapshot: the first one, or a reconnect's, which replaces what the tab had. An answered App
   * change it agrees with ends, and so does one whose App it no longer lists.
   */
  snapshot(snapshot: WorkspaceSnapshot): void {
    const next = fromSnapshot(snapshot)
    this.#feedApps = next.apps
    this.#pending.heard(next.apps, () => true)
    this.#write(next)
    this.#synced = true
    this.#first.resolve()
  }

  /** Changes from the feed, onto the slices as they are. */
  changes(changes: readonly WorkspaceChange[]): void {
    const next = applyChanges(this.#current(), changes)
    const removed = new Set(changes.flatMap((change) => (change.type === 'app-removed' ? [change.id] : [])))
    this.#feedApps = next.apps
    this.#pending.heard(next.apps, (id) => removed.has(id))
    this.#write(next)
  }

  /** What the server answered the owner's change with, shown before the feed repeats it. */
  show(changes: readonly AnsweredChange[]): void {
    this.#write(applyChanges(this.#current(), changes))
  }

  /** An App change on its way, shown at once as `shown`; pass what this returns on to its answer or refusal. */
  appStarted(shown: AppView): AppChange {
    const change = this.#pending.start(shown)
    this.#write(this.#current())
    return change
  }

  /** The server answered an App change (`change`, if it showed itself while on its way) with `app`. */
  appAnswered(app: AppView, change?: AppChange): void {
    this.#pending.answered(app, this.#feedApps, change)
    this.#write(this.#current())
  }

  /** The server refused an App change: the App shows as the feed has it. */
  appRefused(change: AppChange): void {
    this.#pending.refused(change)
    this.#write(this.#current())
  }

  /** What is wrong with the feed, in words; undefined once it is healthy again. */
  report(problem: string | undefined): void {
    setFeedStatus(this.#client, problem ?? '')
  }

  /** Follows the feed `events` opens until the returned function is called; one connection at a time. */
  connect(events: () => PiEventSource): () => void {
    this.#connection?.dispose()
    const connection = new WorkspaceFeedConnection(events, this)
    this.#connection = connection
    connection.connect()
    return () => {
      connection.dispose()
      if (this.#connection !== connection) return
      this.#connection = undefined
      // A later connection's snapshot is what a new read waits for; a read already waiting keeps waiting for it.
      if (this.#synced) this.#first = deferred()
      this.#synced = false
    }
  }

  #cached<K extends Slice>(slice: K): Slices[K] | undefined {
    return this.#client.getQueryData<Slices[K]>(workspaceKeys.slice(slice))
  }

  #present(): Cached {
    return {
      conversations: this.#cached('conversations'),
      activity: this.#cached('activity'),
      apps: this.#cached('apps'),
      topics: this.#cached('topics'),
      personas: this.#cached('personas'),
      invocations: this.#cached('invocations'),
      receipts: this.#cached('receipts'),
    }
  }

  /** The slices as the feed left them: the cache's, but the feed's own Apps. */
  #current(): Slices {
    const cached = this.#present()
    return {
      conversations: cached.conversations ?? EMPTY_WORKSPACE.conversations,
      activity: cached.activity ?? EMPTY_WORKSPACE.activity,
      apps: this.#feedApps,
      topics: cached.topics ?? EMPTY_WORKSPACE.topics,
      personas: cached.personas ?? EMPTY_WORKSPACE.personas,
      invocations: cached.invocations ?? EMPTY_WORKSPACE.invocations,
      receipts: cached.receipts ?? EMPTY_WORKSPACE.receipts,
    }
  }

  #set<K extends Slice>(slice: K, value: Slices[K]): void {
    if (this.#cached(slice) !== value) this.#client.setQueryData<Slices[K]>(workspaceKeys.slice(slice), value)
  }

  /**
   * Writes the slices that changed, with the owner's pending App changes shown over the feed's Apps, then reads again
   * what went stale with the change (`staleAfter`).
   */
  #write(next: Slices): void {
    const shown = { ...next, apps: this.#pending.over(next.apps) }
    const before = this.#present()
    for (const slice of SLICE_NAMES) this.#set(slice, shown[slice])
    for (const queryKey of staleAfter(before, this.#present()))
      this.#client.invalidateQueries({ queryKey }).catch(reportUnexpected)
  }
}

const syncs = new WeakMap<QueryClient, WorkspaceSync>()

/** The workspace feed's writer into `client`'s cache, made once per client. */
export function workspaceSync(client: QueryClient): WorkspaceSync {
  const existing = syncs.get(client)
  if (existing !== undefined) return existing
  const sync = new WorkspaceSync(client)
  syncs.set(client, sync)
  return sync
}

/** Shows what the server just answered a change with (a thread, a Topic, a Persona…) before the feed repeats it. */
export const applyWorkspaceChanges = (client: QueryClient, changes: readonly AnsweredChange[]): void =>
  workspaceSync(client).show(changes)

/** Sets what is wrong with the feed or with the owner's last change to it, in words; empty when nothing is. */
export function setFeedStatus(client: QueryClient, problem: string): void {
  if (client.getQueryData<string>(workspaceKeys.status) !== problem)
    client.setQueryData<string>(workspaceKeys.status, problem)
}

/** One slice's read: it waits for the feed's first snapshot, and the feed keeps it current after that. */
const sliceQuery = <K extends Slice>(slice: K) =>
  queryOptions({
    queryKey: workspaceKeys.slice(slice),
    queryFn: ({ client }): Promise<Slices[K]> => workspaceSync(client).read(slice),
  })

export const workspaceQueries = {
  conversations: sliceQuery('conversations'),
  activity: sliceQuery('activity'),
  apps: sliceQuery('apps'),
  topics: sliceQuery('topics'),
  personas: sliceQuery('personas'),
  invocations: sliceQuery('invocations'),
  receipts: sliceQuery('receipts'),
  /** Empty until the feed or one of the owner's changes to it goes wrong. */
  status: queryOptions({
    queryKey: workspaceKeys.status,
    queryFn: ({ client }) => client.getQueryData<string>(workspaceKeys.status) ?? '',
  }),
}
