import type { RunEvent } from '@goblin/contracts/telemetry'
import { writeLine } from '../observability/logger.ts'
import type { RunSink } from './events.ts'
import { expectedFailure } from './safety.ts'

/**
 * One Workers Log line per run event that ended (ADR 0024): its ids, outcome, duration and attributes, so the
 * dashboard and the Observability API can find a turn by `operation` or `conversation`. Never content.
 */
export class RunLog implements RunSink {
  readonly name = 'log'
  readonly #agent: () => string

  constructor(agent: () => string) {
    this.#agent = agent
  }

  started(): void {
    // A start is in the ledger; the log line comes when it ends, with its duration.
  }

  /** Through the logger, whose allowlist keeps the ids and attributes and drops anything else (ADR 0024). */
  ended(event: RunEvent): void {
    const quiet = event.status === 'ok' || event.status === 'blocked' || expectedFailure(event.attributes['error.type'])
    writeLine(quiet ? 'info' : 'warn', {
      ...event.attributes,
      event: 'run',
      kind: event.kind,
      status: event.status,
      agent: this.#agent(),
      ...(event.conversationId === undefined ? {} : { conversation: event.conversationId }),
      ...(event.operationId === undefined ? {} : { operation: event.operationId }),
      ...(event.taskId === undefined ? {} : { task: event.taskId }),
      id: event.id,
      ...(event.endedAt === undefined ? {} : { ms: event.endedAt - event.startedAt }),
    })
  }
}
