import { Predicate } from 'effect'
import { nowMillis } from '../clock.ts'

type Step = {
  readonly step: 'connect' | 'call' | 'skills' | 'events'
  readonly serverId: string
  readonly tool?: string
  readonly method?: 'events/list' | 'events/poll' | 'events/subscribe' | 'events/unsubscribe'
}

/** `ok`, or the error's tag with its reason (`UpstreamMcp:timeout`). */
const outcomeOf = (error: unknown): string => {
  if (!Predicate.isObject(error) || !('_tag' in error) || !Predicate.isString(error._tag)) return 'error'
  return 'reason' in error && Predicate.isString(error.reason) ? `${error._tag}:${error.reason}` : error._tag
}

/**
 * Runs one remote MCP step and writes one structured log line: the step, server, tool, outcome and duration. Never
 * arguments, results or credentials. This is how a slow connect or call shows up in the Worker's logs.
 */
export async function timed<T>(step: Step, work: () => Promise<T>): Promise<T> {
  const started = nowMillis()
  try {
    const value = await work()
    console.log(JSON.stringify({ level: 'info', event: 'mcp', ...step, outcome: 'ok', ms: nowMillis() - started }))
    return value
  } catch (error) {
    const line = { level: 'warn', event: 'mcp', ...step, outcome: outcomeOf(error), ms: nowMillis() - started }
    console.warn(JSON.stringify(line))
    throw error
  }
}

/** One log line when servers lost their credentials and grants because their endpoint changed (ids only). */
export function logEndpointsReset(serverIds: readonly string[]): void {
  console.warn(JSON.stringify({ level: 'warn', event: 'mcp', step: 'endpoint-changed', serverIds }))
}
