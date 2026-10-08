import {
  ConversationStream,
  type PiStreamDependencies,
  type ReconnectScheduler,
  type StreamStatus,
  browserScheduler,
} from './conversation-stream.ts'
import type { ConversationProjection } from './projection.ts'

/** What everyone following a conversation sees: its projection, the stream's state and what went wrong. */
export type StreamState = {
  readonly projection: ConversationProjection | undefined
  /** `suspended`: nobody has looked at it for a while, so it stopped following until someone does. */
  readonly status: StreamStatus | 'suspended'
  readonly notice: string
}

/** One consumer of a conversation's stream: a pane or an inline thread. */
export type Lease = {
  /** Whether the consumer is on screen; an off-screen conversation stops following after a while. */
  readonly setVisible: (visible: boolean) => void
  readonly release: () => void
}

type Entry = {
  readonly stream: ConversationStream
  readonly listeners: Map<symbol, { visible: boolean; listener: (state: StreamState) => void }>
  state: StreamState
  live: boolean
  /** When a consumer last had it on screen; the least recently seen is suspended first. */
  seenAt: number
  cancelSuspend: (() => void) | undefined
}

export type StreamPoolOptions = {
  /** At most this many conversations follow at once, beyond those on screen. */
  readonly max?: number
  /** How long a conversation nobody sees keeps following. */
  readonly idleMs?: number
  readonly scheduler?: ReconnectScheduler
  readonly now?: () => number
}

const INITIAL: StreamState = { projection: undefined, status: 'connecting', notice: '' }

/**
 * One stream per conversation, however many panes and inline threads follow it, so the browser holds as few event
 * streams as the screen needs. A conversation nobody has on screen keeps following for `idleMs` and then is suspended;
 * at most `max` follow at once, the least recently seen suspended first, never one on screen. Coming back on screen
 * resumes from a fresh snapshot. The last consumer's release ends it.
 */
export class StreamPool {
  readonly #entries = new Map<string, Entry>()
  readonly #max: number
  readonly #idleMs: number
  readonly #scheduler: ReconnectScheduler
  readonly #now: () => number

  constructor(
    readonly dependencies: (id: string) => PiStreamDependencies,
    options: StreamPoolOptions = {},
  ) {
    this.#max = options.max ?? 8
    this.#idleMs = options.idleMs ?? 10_000
    this.#scheduler = options.scheduler ?? browserScheduler
    this.#now = options.now ?? Date.now
  }

  acquire(id: string, visible: boolean, listener: (state: StreamState) => void): Lease {
    const entry = this.#entries.get(id) ?? this.#create(id)
    const key = Symbol(id)
    entry.listeners.set(key, { visible, listener })
    listener(entry.state)
    this.#settle(id, entry)
    return {
      setVisible: (next) => {
        const consumer = entry.listeners.get(key)
        if (consumer === undefined || consumer.visible === next) return
        consumer.visible = next
        this.#settle(id, entry)
      },
      release: () => {
        if (!entry.listeners.delete(key)) return
        if (entry.listeners.size > 0) return this.#settle(id, entry)
        entry.cancelSuspend?.()
        entry.stream.dispose()
        this.#entries.delete(id)
      },
    }
  }

  /** Every following conversation starts again from a fresh snapshot (the tab came back, the network returned). */
  resume(): void {
    for (const entry of this.#entries.values()) if (entry.live) void entry.stream.reconnect()
  }

  /** A send or removal changed the native inbox; share its next content read with every consumer. */
  refreshQueue(id: string): void {
    const entry = this.#entries.get(id)
    if (entry?.live) void entry.stream.refreshQueue()
  }

  /** How many conversations follow now. */
  get live(): number {
    return [...this.#entries.values()].filter((entry) => entry.live).length
  }

  #create(id: string): Entry {
    const entry: Entry = {
      listeners: new Map(),
      state: INITIAL,
      live: false,
      seenAt: this.#now(),
      cancelSuspend: undefined,
      stream: new ConversationStream(
        this.dependencies(id),
        (projection) => this.#publish(entry, { projection }),
        (status, detail) =>
          this.#publish(entry, {
            status,
            notice: status === 'reconnecting' ? `${detail ?? 'Disconnected'}. Reconnecting…` : '',
          }),
        this.#scheduler,
      ),
    }
    this.#entries.set(id, entry)
    return entry
  }

  #publish(entry: Entry, change: Partial<StreamState>): void {
    if (!entry.live && change.status !== undefined) return
    entry.state = { ...entry.state, ...change }
    for (const { listener } of entry.listeners.values()) listener(entry.state)
  }

  #visible = (entry: Entry) => [...entry.listeners.values()].some((consumer) => consumer.visible)

  /** On screen: follow now. Off screen: keep following for a while, then suspend. Then keep within `max`. */
  #settle(id: string, entry: Entry): void {
    entry.cancelSuspend?.()
    entry.cancelSuspend = undefined
    if (this.#visible(entry)) {
      entry.seenAt = this.#now()
      if (!entry.live) this.#start(entry)
    } else if (entry.live) {
      entry.cancelSuspend = this.#scheduler.schedule(() => this.#suspend(entry), this.#idleMs)
    }
    this.#limit(id)
  }

  #start(entry: Entry): void {
    entry.live = true
    void entry.stream.reconnect()
  }

  #suspend(entry: Entry): void {
    entry.cancelSuspend = undefined
    if (!entry.live || this.#visible(entry)) return
    entry.stream.dispose()
    entry.live = false
    entry.state = { ...entry.state, status: 'suspended', notice: '' }
    for (const { listener } of entry.listeners.values()) listener(entry.state)
  }

  /** Over `max`, the least recently seen conversations nobody has on screen stop following, `keep` last. */
  #limit(keep: string): void {
    const live = [...this.#entries.entries()].filter(([, entry]) => entry.live)
    let over = live.length - this.#max
    const idle = live
      .filter(([id, entry]) => !this.#visible(entry) && id !== keep)
      .toSorted(([, one], [, other]) => one.seenAt - other.seenAt)
    for (const [, entry] of idle) {
      if (over <= 0) break
      entry.cancelSuspend?.()
      this.#suspend(entry)
      over -= 1
    }
  }
}
