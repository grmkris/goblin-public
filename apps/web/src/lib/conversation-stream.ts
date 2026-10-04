import type { JsonValue } from '@purrable/contracts'
import { isString } from './boundary.ts'
import { projectBatch, projectSnapshot, type ConversationProjection } from './projection.ts'

export interface PiEventSource {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void
  close(): void
  onError(listener: () => void): void
}
export class BrowserPiEvents implements PiEventSource {
  readonly source: EventSource
  constructor(url: string) {
    this.source = new EventSource(url)
  }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.source.addEventListener(type, (event) => {
      if (event instanceof MessageEvent && isString(event.data)) listener(event)
    })
  }
  close(): void {
    this.source.close()
  }
  onError(listener: () => void): void {
    this.source.addEventListener('error', listener)
  }
}
export type PiStreamDependencies = {
  readonly snapshot: (signal: AbortSignal) => Promise<JsonValue>
  readonly events: () => PiEventSource
}
/** Timers, injectable so tests can drive reconnection without waiting. */
export type ReconnectScheduler = {
  readonly schedule: (run: () => void, delayMs: number) => () => void
}
const browserScheduler: ReconnectScheduler = {
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
      this.publish(this.#projection)
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
      if (!controller.signal.aborted) this.#retry(error instanceof Error ? error.message : 'Connection failed')
    }
  }

  #receive(
    kind: 'snapshot' | 'batch',
    event: MessageEvent<string>,
    controller: AbortController,
    source: PiEventSource,
  ): void {
    if (controller.signal.aborted) return
    try {
      const value: unknown = JSON.parse(event.data)
      if (kind === 'snapshot') this.#projection = projectSnapshot(value)
      else if (this.#projection) this.#projection = projectBatch(this.#projection, value)
      if (this.#projection) this.publish(this.#projection)
    } catch {
      source.close()
      this.#retry('Stream data could not be read')
    }
  }
}
