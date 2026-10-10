import type { WorkspaceChange, WorkspaceSnapshot } from '@goblin/contracts'
import {
  type PiEventSource,
  type ReconnectScheduler,
  browserScheduler,
  reconnectDelay,
} from '../conversation-stream.ts'
import { reportUnexpected } from '../unexpected.ts'
import { decodeChanges, decodeSnapshot } from './decode.ts'

/** Where the feed's frames go: each (re)connect's snapshot, the changes after it, and what is wrong (or undefined). */
type FeedSink = {
  readonly snapshot: (snapshot: WorkspaceSnapshot) => void
  readonly changes: (changes: readonly WorkspaceChange[]) => void
  readonly report: (problem: string | undefined) => void
}

/**
 * The workspace feed for the browser: one SSE stream, a snapshot on every (re)connect, then changes. A dropped or
 * unreadable stream reconnects on its own with backoff and starts again from a fresh snapshot.
 */
export class WorkspaceFeedConnection {
  #source: PiEventSource | undefined
  /** Whether the open stream sent its snapshot: a change before it has nothing to apply to. */
  #synced = false
  #cancelRetry: (() => void) | undefined
  #attempt = 0
  #disposed = false

  constructor(
    readonly events: () => PiEventSource,
    readonly sink: FeedSink,
    readonly scheduler: ReconnectScheduler = browserScheduler,
  ) {}

  connect(): void {
    this.#detach()
    this.#disposed = false
    const source = this.events()
    this.#source = source
    source.addEventListener('snapshot', (event) => {
      const snapshot = this.#read(source, () => decodeSnapshot(JSON.parse(event.data)))
      if (snapshot === undefined) return
      this.#synced = true
      this.#delivered(() => this.sink.snapshot(snapshot))
    })
    source.addEventListener('change', (event) => {
      if (!this.#synced) return
      const changes = this.#read(source, () => decodeChanges(JSON.parse(event.data)))
      if (changes !== undefined) this.#delivered(() => this.sink.changes(changes))
    })
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
    this.#synced = false
  }

  /**
   * A frame of the open stream, or undefined for one of an old stream. One this tab cannot read starts again from a
   * fresh snapshot and is reported: the server sent it, so it is a bug or a frame shape this tab does not know, never
   * the network.
   */
  #read<A>(source: PiEventSource, decode: () => A): A | undefined {
    if (this.#source !== source) return undefined
    try {
      return decode()
    } catch (error) {
      this.#retry('Workspace data could not be read')
      reportUnexpected(error)
      return undefined
    }
  }

  /** A frame read: it goes to the sink, and the stream is healthy again. */
  #delivered(deliver: () => void): void {
    this.#attempt = 0
    deliver()
    this.sink.report(undefined)
  }

  #retry(problem: string): void {
    this.#detach()
    if (this.#disposed) return
    this.sink.report(problem)
    const delay = reconnectDelay(this.#attempt)
    this.#attempt += 1
    this.#cancelRetry = this.scheduler.schedule(() => this.connect(), delay)
  }
}
