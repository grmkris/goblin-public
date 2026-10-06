import { RunAttribute, type RunAttributes, type RunEvent } from '@goblin/contracts/telemetry'
import type { RunSink } from './events.ts'

/** The part of a Cloudflare span the sink uses (`cloudflare:workers` `tracing`), injected so tests need no workerd. */
export type TraceSpan = {
  setAttributes(attributes: Record<string, string | number | boolean | undefined>): unknown
  setStatus(status: { readonly code: 'unset' | 'ok' | 'error'; readonly message?: string }): unknown
  end(): void
}
export type Tracer = { startSpan(name: string): TraceSpan }

/** Spans still open; beyond this the oldest is ended, so a lost end cannot grow the map. */
const MAX_OPEN = 200
const AGENT_NAME = 'goblin'

const text = (value: RunAttributes[string] | undefined) => (typeof value === 'string' ? value : '')

/**
 * The OpenTelemetry GenAI span a run event becomes, or none: a model call is `chat {model}`, a tool call is
 * `execute_tool {tool}`. Turns, MCP steps and channel events stay in the ledger and logs; they span invocations.
 */
export function spanNameOf(event: RunEvent): string | undefined {
  if (event.kind === 'model.attempt' || event.kind === 'model.aux')
    return `chat ${text(event.attributes[RunAttribute.requestModel]) || 'model'}`
  if (event.kind === 'tool.call') return `execute_tool ${text(event.attributes[RunAttribute.toolName]) || 'tool'}`
  return undefined
}

/**
 * Run events as spans in the invocation's Cloudflare trace (ADR 0024): the same GenAI attribute names, plus the agent,
 * conversation and operation ids. Ids, numbers, names and bounded error text only; never content.
 */
export class TraceSink implements RunSink {
  readonly name = 'trace'
  readonly #tracer: Tracer
  readonly #agent: () => string
  readonly #open = new Map<string, TraceSpan>()

  constructor(tracer: Tracer, agent: () => string) {
    this.#tracer = tracer
    this.#agent = agent
  }

  started(event: RunEvent): void {
    const name = spanNameOf(event)
    if (name === undefined || this.#open.has(event.id)) return
    const span = this.#tracer.startSpan(name)
    span.setAttributes(this.#identity(event))
    this.#open.set(event.id, span)
    if (this.#open.size > MAX_OPEN) {
      const [oldest] = this.#open
      if (oldest !== undefined) this.#close(oldest[0], oldest[1], { code: 'unset' })
    }
  }

  /** An event that started in an earlier invocation has no span here; its record is in the ledger and the log. */
  ended(event: RunEvent): void {
    const span = this.#open.get(event.id)
    if (span === undefined) return
    span.setAttributes({ ...this.#identity(event), ...event.attributes, 'goblin.status': event.status })
    const message = text(event.attributes[RunAttribute.error]) || text(event.attributes[RunAttribute.reason])
    this.#close(event.id, span, event.status === 'ok' ? { code: 'ok' } : { code: 'error', message })
  }

  #identity(event: RunEvent) {
    return {
      'gen_ai.agent.name': AGENT_NAME,
      'gen_ai.agent.id': this.#agent(),
      'gen_ai.conversation.id': event.conversationId,
      'goblin.operation': event.operationId,
      'goblin.event': event.id,
    }
  }

  #close(id: string, span: TraceSpan, status: { readonly code: 'unset' | 'ok' | 'error'; readonly message?: string }) {
    this.#open.delete(id)
    span.setStatus(status)
    span.end()
  }
}
