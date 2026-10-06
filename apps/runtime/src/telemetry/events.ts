import { RunAttribute, type RunAttributes, type RunEvent, type RunEventStatus } from '@goblin/contracts/telemetry'

/** Where run events go (ADR 0024): the ledger, a log line, a test's list. */
export interface RunSink {
  /** For the log line when this sink fails. */
  readonly name: string
  /** An event that has started and not ended yet. */
  started(event: RunEvent): void
  /** An event in its final state: one that ended, or one recorded whole. */
  ended(event: RunEvent): void
}

/** How an event that started ends. */
export type RunEnd = {
  readonly status: Exclude<RunEventStatus, 'started'>
  readonly endedAt: number
  readonly attributes?: RunAttributes
}

/** One string attribute at most this long; error text from providers and servers is often long. */
const MAX_VALUE = 500
/** All of an event's attributes at most this many characters, as JSON. */
const MAX_ATTRIBUTES = 2048
/** Sink failures logged per object, then dropped quietly: telemetry never floods its own log. */
const MAX_FAILURE_LINES = 5
/** Started events held in memory; past this the oldest is forgotten and is ended from the ledger instead. */
const MAX_OPEN = 1000

/** Shorten long values and drop attributes past the bound, marking the event so a reader knows. */
export function boundAttributes(attributes: RunAttributes): RunAttributes {
  const bounded: Record<string, string | number | boolean> = {}
  let size = 2
  let truncated = false
  for (const [key, raw] of Object.entries(attributes)) {
    const value = typeof raw === 'string' && raw.length > MAX_VALUE ? `${raw.slice(0, MAX_VALUE)}…` : raw
    if (value !== raw) truncated = true
    const cost = JSON.stringify(key).length + JSON.stringify(value).length + 2
    if (size + cost > MAX_ATTRIBUTES) {
      truncated = true
      continue
    }
    bounded[key] = value
    size += cost
  }
  if (truncated) bounded[RunAttribute.truncated] = true
  return bounded
}

/**
 * The run events of one agent, fanned out to its sinks. Recording never throws: a failing sink is logged and the
 * caller (a Pi commit listener, a submission, a log site) carries on. An event that started is ended by id, also
 * after a restart, when `recall` finds it in the ledger.
 */
export class RunTelemetry {
  readonly #sinks: readonly RunSink[]
  readonly #recall: (id: string) => RunEvent | undefined
  readonly #open = new Map<string, RunEvent>()
  #failures = 0
  #sequence = 0

  constructor(sinks: readonly RunSink[], recall: (id: string) => RunEvent | undefined = () => undefined) {
    this.#sinks = sinks
    this.#recall = recall
  }

  /** A new id for an event that has none of its own (a model call outside a turn, an MCP step). */
  id(prefix: string, at: number): string {
    this.#sequence += 1
    return `${prefix}:${at.toString(36)}:${this.#sequence.toString(36)}`
  }

  /** Record that `event` started; its status is `started` whatever it says. */
  begin(event: Omit<RunEvent, 'status' | 'endedAt'>): void {
    const started: RunEvent = { ...event, status: 'started', attributes: boundAttributes(event.attributes) }
    this.#open.set(started.id, started)
    if (this.#open.size > MAX_OPEN) this.#open.delete(this.#open.keys().next().value ?? started.id)
    this.#each((sink) => sink.started(started))
  }

  /** Add attributes to an event that has started and not ended (in this object). */
  annotate(id: string, attributes: RunAttributes): void {
    const open = this.#open.get(id)
    if (open === undefined) return
    const annotated: RunEvent = { ...open, attributes: boundAttributes({ ...open.attributes, ...attributes }) }
    this.#open.set(id, annotated)
    this.#each((sink) => sink.started(annotated))
  }

  /** Whether `id` started and has not ended, in this object or in the ledger. */
  isOpen(id: string): boolean {
    return (this.#open.get(id) ?? this.#recallSafely(id))?.status === 'started'
  }

  /**
   * End the event `id`, merging attributes. An event this object never saw start (it started before a restart and the
   * ledger has no row) is recorded from `fallback` when one is given, and dropped otherwise.
   */
  finish(id: string, end: RunEnd, fallback?: Omit<RunEvent, 'status' | 'endedAt'>): void {
    const known = this.#open.get(id) ?? this.#recallSafely(id)
    const base = known ?? fallback
    this.#open.delete(id)
    if (base === undefined) return
    const resumed = known?.status === 'interrupted' ? { [RunAttribute.recovery]: 'resumed' } : {}
    const ended: RunEvent = {
      ...base,
      status: end.status,
      endedAt: end.endedAt,
      attributes: boundAttributes({ ...base.attributes, ...resumed, ...end.attributes }),
    }
    this.#each((sink) => sink.ended(ended))
  }

  /** Record an event that is already over, or that has no duration. */
  record(event: RunEvent): void {
    const ended: RunEvent = { ...event, attributes: boundAttributes(event.attributes) }
    this.#each((sink) => sink.ended(ended))
  }

  #recallSafely(id: string): RunEvent | undefined {
    try {
      return this.#recall(id)
    } catch (error) {
      this.#failed('recall', error)
      return undefined
    }
  }

  #each(write: (sink: RunSink) => void): void {
    for (const sink of this.#sinks) {
      try {
        write(sink)
      } catch (error) {
        this.#failed(sink.name, error)
      }
    }
  }

  #failed(where: string, error: unknown): void {
    this.#failures += 1
    if (this.#failures > MAX_FAILURE_LINES) return
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300)
    console.warn(JSON.stringify({ level: 'warn', event: 'telemetry', where, error: message }))
  }
}

/** Keeps every event in memory, last state per id: tests read it, and the benchmark's agent can too. */
export class CollectedRuns implements RunSink {
  readonly name = 'collected'
  readonly #events = new Map<string, RunEvent>()
  started(event: RunEvent): void {
    this.#events.set(event.id, event)
  }
  ended(event: RunEvent): void {
    this.#events.set(event.id, event)
  }
  /** Every event in the order it first appeared. */
  events(): readonly RunEvent[] {
    return [...this.#events.values()]
  }
}
