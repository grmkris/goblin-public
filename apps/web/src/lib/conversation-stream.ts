import { ConversationQueue, type QueuedInput } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { isString } from './values.ts'
import { projectBatch, projectSnapshot, type ConversationProjection } from './projection.ts'
import { reportUnexpected } from './unexpected.ts'

export interface PiEventSource {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void
  close(): void
  onError(listener: () => void): void
}
/** A message event whose data is text, as every server-sent event's is. */
const isTextMessage = (event: Event): event is MessageEvent<string> =>
  event instanceof MessageEvent && isString(event.data)

export class BrowserPiEvents implements PiEventSource {
  readonly source: EventSource
  constructor(url: string) {
    this.source = new EventSource(url)
  }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.source.addEventListener(type, (event) => {
      if (isTextMessage(event)) listener(event)
    })
  }
  close(): void {
    this.source.close()
  }
  onError(listener: () => void): void {
    this.source.addEventListener('error', listener)
  }
}
/** The stream's own reads (`conversations/queries.ts`): a Pi snapshot and the queued inputs, each read as it comes. */
export type PiStreamDependencies = {
  readonly snapshot: (signal: AbortSignal) => Promise<unknown>
  readonly queue: (signal: AbortSignal) => Promise<unknown>
  readonly events: () => PiEventSource
}
/** Timers, injectable so tests can drive reconnection without waiting. */
export type ReconnectScheduler = {
  readonly schedule: (run: () => void, delayMs: number) => () => void
}
export const browserScheduler: ReconnectScheduler = {
  schedule: (run, delayMs) => {
    const handle = setTimeout(run, delayMs)
    return () => clearTimeout(handle)
  },
}
export type StreamStatus = 'connecting' | 'connected' | 'reconnecting'

/** 1s, 2s, 4s ... capped at 30s, with up to 20% jitter so reconnecting tabs do not stampede. */
export const reconnectDelay = (attempt: number, jitter = Math.random()): number =>
  Math.round(Math.min(30_000, 1000 * 2 ** attempt) * (1 + 0.2 * jitter))

/**
 * Committed Pi state for the browser: a snapshot, then live batches. Every (re)connect fetches a fresh snapshot and
 * disposes the previous stream first; a dropped stream reconnects on its own with backoff.
 */
export class ConversationStream {
  #controller: AbortController | undefined
  #source: PiEventSource | undefined
  #projection: ConversationProjection | undefined
  #cancelRetry: (() => void) | undefined
  #queueController: AbortController | undefined
  #queueCache: readonly QueuedInput[] = []
  #cancelQueueRetry: (() => void) | undefined
  #queueAttempt = 0
  #attempt = 0
  #disposed = false
  constructor(
    readonly dependencies: PiStreamDependencies,
    readonly publish: (projection: ConversationProjection) => void,
    readonly report: (status: StreamStatus, detail?: string) => void,
    readonly scheduler: ReconnectScheduler = browserScheduler,
  ) {}

  #detach(): void {
    this.#cancelRetry?.()
    this.#cancelRetry = undefined
    this.#controller?.abort()
    this.#queueController?.abort()
    this.#cancelQueueRetry?.()
    this.#cancelQueueRetry = undefined
    this.#source?.close()
    this.#source = undefined
  }

  dispose(): void {
    this.#disposed = true
    this.#detach()
  }

  #retry(detail: string): void {
    if (this.#disposed) return
    this.report('reconnecting', detail)
    const delay = reconnectDelay(this.#attempt)
    this.#attempt += 1
    this.#cancelRetry = this.scheduler.schedule(() => void this.reconnect(), delay)
  }

  async reconnect(): Promise<void> {
    this.#detach()
    this.#disposed = false
    const controller = new AbortController()
    this.#controller = controller
    this.report('connecting')
    try {
      const snapshot = await this.dependencies.snapshot(controller.signal)
      if (controller.signal.aborted) return
      this.#projection = projectSnapshot(snapshot)
      this.#publishQueue()
      this.refreshQueue().catch(reportUnexpected)
      const source = this.dependencies.events()
      this.#source = source
      source.addEventListener('snapshot', (event) => this.#receive('snapshot', event, controller, source))
      source.addEventListener('batch', (event) => this.#receive('batch', event, controller, source))
      source.onError(() => {
        source.close()
        if (!controller.signal.aborted) this.#retry('Connection interrupted')
      })
      this.#attempt = 0
      this.report('connected')
    } catch (error) {
      // expected: an unreachable or unreadable snapshot shows as reconnecting, with its reason, and is retried
      if (!controller.signal.aborted) this.#retry(error instanceof Error ? error.message : 'Connection failed')
    }
  }

  /** One cancellable content read per shared conversation. Native inbox membership always wins over late reads. */
  async refreshQueue(): Promise<void> {
    if (this.#disposed || this.#controller?.signal.aborted !== false || this.#projection === undefined) return
    this.#queueController?.abort()
    this.#cancelQueueRetry?.()
    this.#cancelQueueRetry = undefined
    const controller = new AbortController()
    this.#queueController = controller
    try {
      const queue = Schema.decodeUnknownSync(ConversationQueue)(await this.dependencies.queue(controller.signal))
      if (controller.signal.aborted || this.#disposed) return
      this.#queueCache = queue.inputs
      this.#projection = { ...this.#projection, queueNotice: '' }
      this.#queueAttempt = 0
      this.#publishQueue()
    } catch {
      // expected: the last contents stay, the queue's notice says the read failed, and it is retried with backoff
      if (controller.signal.aborted || this.#disposed) return
      this.#projection = { ...this.#projection, queueNotice: 'Queued messages could not be refreshed. Retrying…' }
      this.#publishQueue()
      this.#cancelQueueRetry = this.scheduler.schedule(
        () => void this.refreshQueue(),
        reconnectDelay(this.#queueAttempt),
      )
      this.#queueAttempt += 1
    }
  }

  #publishQueue(): void {
    if (this.#projection === undefined) return
    const byId = new Map(this.#queueCache.map((item) => [item.id, item]))
    const queued = this.#projection.inbox.flatMap(({ id }) => {
      const item = byId.get(id)
      return item === undefined ? [] : [item]
    })
    this.#projection = { ...this.#projection, queued }
    this.publish(this.#projection)
  }

  /**
   * A frame of the open stream. One this tab cannot read starts again from a fresh snapshot and is reported: the server
   * sent it, so it is a bug or a contract this tab does not know, never the network.
   */
  #receive(
    kind: 'snapshot' | 'batch',
    event: MessageEvent<string>,
    controller: AbortController,
    source: PiEventSource,
  ): void {
    if (controller.signal.aborted) return
    const previous = this.#projection
    let next: ConversationProjection | undefined
    try {
      const value: unknown = JSON.parse(event.data)
      next = kind === 'snapshot' ? projectSnapshot(value) : previous && projectBatch(previous, value)
    } catch (error) {
      source.close()
      this.#retry('Stream data could not be read')
      reportUnexpected(error)
      return
    }
    if (next === undefined) return
    this.#projection = next
    this.#publishQueue()
    if (kind === 'snapshot' || previous?.inbox !== next.inbox) this.refreshQueue().catch(reportUnexpected)
  }
}
