import type { TaskGraph, TaskGraphWatch } from '@earendil-works/pi-durable'
import type { ConversationActivity, WorkspaceChange, WorkspaceSnapshot } from '@purrable/contracts'
import type { PiHarness } from 'agents/harness/pi'
import type { AppRegistry } from '../apps/registry.ts'
import type { ConversationRegistry } from '../conversations.ts'
import { sseResponse } from '../http/sse.ts'
import { BACKGROUND } from '../pi/context.ts'
import { SUBAGENT_RELAY } from '../pi/subagent-relay.ts'

type Busy = 'working' | 'waiting'

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

type Listener = (changes: readonly WorkspaceChange[]) => void

/**
 * The owner's workspace as one live feed: every conversation and what each is doing, so a client needs no polling and
 * no stream per conversation to draw the tree. It watches Pi's task graph while anyone listens, and the registry's
 * writes. Activity lives in this isolate; a client that reconnects starts again from a fresh snapshot.
 */
export class WorkspaceFeed {
  readonly #harness: PiHarness
  readonly #conversations: ConversationRegistry
  readonly #apps: AppRegistry
  readonly #listeners = new Set<Listener>()
  #activity = new Map<string, ConversationActivity>()
  #watch: Promise<TaskGraphWatch> | undefined

  constructor(harness: PiHarness, conversations: ConversationRegistry, apps: AppRegistry) {
    this.#harness = harness
    this.#conversations = conversations
    this.#apps = apps
    conversations.onChange((ids) => {
      if (this.#listeners.size > 0) void this.#describe(ids)
    })
    apps.onChange((changed) => this.#emit(changed.map((app) => ({ type: 'app' as const, app }))))
  }

  /**
   * Subscribes `send` and gives it the snapshot first: changes that land while the snapshot is read are held and sent
   * after it, so they are never older than what it shows. Returns what unsubscribes.
   */
  async open(send: (event: 'snapshot' | 'change', data: WorkspaceSnapshot | readonly WorkspaceChange[]) => void) {
    const held: WorkspaceChange[] = []
    let ready = false
    const listener: Listener = (changes) => {
      if (ready) send('change', changes)
      else held.push(...changes)
    }
    this.#listeners.add(listener)
    const close = async () => {
      this.#listeners.delete(listener)
      if (this.#listeners.size === 0) await this.#unwatch()
    }
    try {
      await this.#watching()
      const conversations = await this.#conversations.list()
      send('snapshot', { conversations, activity: [...this.#activity.values()], apps: this.#apps.list() })
    } catch (error) {
      await close()
      throw error
    }
    ready = true
    if (held.length > 0) send('change', held)
    return close
  }

  #emit(changes: readonly WorkspaceChange[]): void {
    if (changes.length > 0) for (const listener of this.#listeners) listener(changes)
  }

  async #describe(ids: readonly string[]): Promise<void> {
    const views = await Promise.all(ids.map(async (id) => this.#conversations.view(id)))
    this.#emit(
      views.flatMap((view) => (view === undefined ? [] : [{ type: 'conversation' as const, conversation: view }])),
    )
  }

  /** The task graph watch, started by the first listener; a failed start is retried by the next. */
  #watching(): Promise<TaskGraphWatch> {
    if (this.#watch !== undefined) return this.#watch
    const watch = (async () => {
      const started = await (await this.#harness.pi()).watchTaskGraph(BACKGROUND)
      await this.#apply(started.value, false)
      started.start(async (graph) => this.#apply(graph, true))
      return started
    })()
    this.#watch = watch
    watch.catch(() => {
      if (this.#watch === watch) this.#watch = undefined
    })
    return watch
  }

  async #unwatch(): Promise<void> {
    const watch = this.#watch
    this.#watch = undefined
    this.#activity = new Map()
    await (await watch)?.stop()
  }

  /**
   * Moves to the graph's activity and sends what changed. A conversation that goes idle is described again too: its
   * run wrote replies, and may have named it.
   */
  async #apply(graph: TaskGraph, announce: boolean): Promise<void> {
    const next = activityOf(graph)
    const now = Date.now()
    const changes: WorkspaceChange[] = []
    const settled: string[] = []
    for (const [id, state] of next) {
      if (this.#activity.get(id)?.state === state) continue
      const activity = { id, state, since: now }
      this.#activity.set(id, activity)
      changes.push({ type: 'activity', activity })
    }
    for (const id of this.#activity.keys()) {
      if (next.has(id)) continue
      this.#activity.delete(id)
      changes.push({ type: 'activity', activity: { id, state: 'idle', since: now } })
      settled.push(id)
    }
    if (!announce) return
    this.#emit(changes)
    await this.#describe(settled)
  }
}

/** The feed as SSE: `event: snapshot` (`WorkspaceSnapshot`), then `event: change` batches. */
export function workspaceEventResponse(feed: WorkspaceFeed): Response {
  return sseResponse((send, finish) => {
    const opened = feed.open(send)
    opened.catch((error: unknown) => finish(error instanceof Error ? error : new Error('workspace_feed')))
    return async () => (await opened.catch(() => undefined))?.()
  })
}
