import type { TaskGraph, TaskGraphWatch } from '@earendil-works/pi-durable'
import type { ConversationActivity, WorkspaceChange, WorkspaceSnapshot } from '@goblin/contracts'
import type { PiHarness } from 'agents/harness/pi'
import type { AppRegistry } from '../apps/registry.ts'
import type { HomeService } from '../home/service.ts'
import type { ChatDirectory } from '../chats/directory.ts'
import type { ConversationRegistry } from '../conversations.ts'
import type { TopicRegistry } from '../topics/registry.ts'
import type { PersonaRegistry } from '../personas/registry.ts'
import type { PersonaInvocations } from '../personas/invocations.ts'
import type { InvocationKey } from '../personas/service.ts'
import type { OrganizeReceipts } from '../organize/receipts.ts'
import { sseResponse } from '../http/sse.ts'
import { writeLine } from '../observability/logger.ts'
import { framesOf, safeErrorType } from '../observability/report.ts'
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

/** A failure of the feed's own work, which no caller awaits: its type and stack locations only (ADR 0024). */
const reportFeedFailure = (where: string, error: unknown): void =>
  writeLine('error', {
    event: 'failure',
    where,
    'error.type': safeErrorType(error),
    frames: error instanceof Error ? framesOf(error) : [],
  })

/**
 * What the feed shows: the conversations, Apps, Home, Topics, Personas, invocations and receipts. Each tells it what
 * changed through the change bus (`workspace/service.ts`), which calls the methods below.
 */
export type FeedSources = {
  readonly conversations: ConversationRegistry
  readonly apps: AppRegistry
  readonly home: HomeService
  readonly topics: TopicRegistry
  readonly personas: PersonaRegistry
  readonly invocations: PersonaInvocations
  readonly receipts: OrganizeReceipts
}

/**
 * The owner's workspace as one live feed: every conversation and what each is doing, so a client needs no polling and
 * no stream per conversation to draw the tree. It watches Pi's task graph while anyone listens; one feed per agent
 * follows the stores' writes. Activity lives in this isolate; a client that reconnects starts
 * again from a fresh snapshot.
 */
export class WorkspaceFeed {
  readonly #harness: PiHarness
  readonly #chats: ChatDirectory
  readonly #conversations: ConversationRegistry
  readonly #apps: AppRegistry
  readonly #home: HomeService
  readonly #topics: TopicRegistry
  readonly #personas: PersonaRegistry
  readonly #invocations: PersonaInvocations
  readonly #receipts: OrganizeReceipts
  readonly #listeners = new Set<Listener>()
  #activity = new Map<string, ConversationActivity>()
  #watch: Promise<TaskGraphWatch> | undefined

  constructor(
    harness: PiHarness,
    { conversations, apps, home, topics, personas, invocations, receipts }: FeedSources,
    chats: ChatDirectory,
  ) {
    this.#harness = harness
    this.#chats = chats
    this.#conversations = conversations
    this.#apps = apps
    this.#home = home
    this.#topics = topics
    this.#personas = personas
    this.#invocations = invocations
    this.#receipts = receipts
  }

  /** Invocations a write changed, each as it is now. */
  invocationsChanged(keys: readonly InvocationKey[]): void {
    if (this.#listeners.size === 0) return
    this.#emit(
      keys.flatMap(({ operationId, persona }) => {
        const invocation = this.#invocations.get(operationId, persona)
        return invocation === undefined ? [] : [{ type: 'invocation' as const, invocation }]
      }),
    )
  }

  /** Conversations a write changed, each described as it is now; read only while someone listens. */
  conversationsChanged(ids: readonly string[]): void {
    if (this.#listeners.size > 0)
      this.#describe(ids).catch((error: unknown) => reportFeedFailure('workspace.describe', error))
  }

  /** Apps a write changed, each as it is now. */
  appsChanged(ids: readonly string[]): void {
    if (this.#listeners.size === 0) return
    this.#emit(ids.map((id) => ({ type: 'app' as const, app: this.#apps.view(id) })))
  }

  /** An App that is gone. */
  appRemoved(id: string): void {
    this.#emit([{ type: 'app-removed' as const, id }])
  }

  /** Topics a write changed, each as it is now; read only while someone listens. */
  topicsChanged(ids: readonly number[]): void {
    if (this.#listeners.size === 0) return
    this.#emit(ids.map((id) => ({ type: 'topic' as const, topic: this.#topics.get(id) })))
  }

  /** Personas a write changed, each as it is now. */
  personasChanged(ids: readonly number[]): void {
    if (this.#listeners.size === 0) return
    this.#emit(ids.map((id) => ({ type: 'persona' as const, persona: this.#personas.get(id) })))
  }

  /** Receipts written or undone, each as Activity shows it now. */
  receiptsChanged(ids: readonly string[]): void {
    if (this.#listeners.size === 0) return
    this.#emit(ids.map((id) => ({ type: 'receipt' as const, receipt: this.#receipts.view(id) })))
  }

  /** The Home layout as it is now. */
  homeChanged(): void {
    if (this.#listeners.size === 0) return
    this.#emit([{ type: 'home' as const, home: this.#home.layout() }])
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
      send('snapshot', {
        primary: this.#chats.primary(),
        conversations,
        activity: [...this.#activity.values()],
        apps: this.#apps.list(),
        home: this.#home.layout(),
        topics: this.#topics.list(),
        personas: this.#personas.list(),
        invocations: this.#invocations.live(),
        receipts: this.#receipts.list(),
      })
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
    // A Persona's fork is hidden: it is never reported as a conversation of its own.
    const views = await Promise.all(
      ids.filter((id) => !this.#chats.isHidden(id)).map(async (id) => this.#conversations.view(id)),
    )
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
      // expected: the listener that started the watch gets its failure; this only lets the next one start it again.
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
    const next = new Map<string, Busy>(
      [...activityOf(graph)].flatMap(([session, state]) => {
        const chat = this.#chats.chatOf(session)
        return chat === undefined || this.#chats.isHidden(chat) ? [] : [[chat, state] as const]
      }),
    )
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
    // A feed that failed to open fails the stream and has nothing to close.
    const opened = feed.open(send).catch((error: unknown) => {
      reportFeedFailure('workspace.open', error)
      finish(error instanceof Error ? error : new Error('workspace_feed'))
      return undefined
    })
    return async () => (await opened)?.()
  })
}
