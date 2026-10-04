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
/** Replaced attachment aborts before requesting a fresh snapshot. Pi's initial stream snapshot closes the attach race. */
export class ConversationStream {
  #controller: AbortController | undefined
  #source: PiEventSource | undefined
  #projection: ConversationProjection | undefined
  constructor(
    readonly dependencies: PiStreamDependencies,
    readonly publish: (projection: ConversationProjection) => void,
    readonly report: (message: string) => void,
  ) {}
  dispose(): void {
    this.#controller?.abort()
    this.#source?.close()
    this.#source = undefined
  }
  async reconnect(): Promise<void> {
    this.dispose()
    const controller = new AbortController()
    this.#controller = controller
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
        if (!controller.signal.aborted) this.report('Connection interrupted. Reconnect to reload committed state.')
      })
      this.report('Connected')
    } catch (error) {
      if (!controller.signal.aborted) this.report(error instanceof Error ? error.message : 'Connection failed')
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
      this.report('Stream data could not be read. Reconnect to reload committed state.')
    }
  }
}
