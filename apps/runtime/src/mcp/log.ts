import { nowMillis } from '../clock.ts'
import { outcomeOf } from '../telemetry/attributes.ts'
import type { McpStep } from '../telemetry/report.ts'

/** Where a finished MCP step goes: the run telemetry (`mcpReporter`), or a plain log line. */
export type StepReport = (step: McpStep, outcome: string, startedAt: number, endedAt: number) => void

/** One structured log line per step, for a manager made without run telemetry. */
const logStep: StepReport = (step, outcome, startedAt, endedAt) => {
  const line = { level: outcome === 'ok' ? 'info' : 'warn', event: 'mcp', ...step, outcome, ms: endedAt - startedAt }
  if (outcome === 'ok') console.log(JSON.stringify(line))
  else console.warn(JSON.stringify(line))
}

/**
 * Runs one remote MCP step and reports it: the step, server, tool, outcome and duration. Never arguments, results or
 * credentials. This is how a slow or failing connect or call shows up in the run ledger and the Worker's logs.
 */
export async function timed<T>(step: McpStep, work: () => Promise<T>, report: StepReport = logStep): Promise<T> {
  const started = nowMillis()
  try {
    const value = await work()
    report(step, 'ok', started, nowMillis())
    return value
  } catch (error) {
    report(step, outcomeOf(error), started, nowMillis())
    throw error
  }
}

/** One log line when servers lost their credentials and grants because their endpoint changed (ids only). */
export function logEndpointsReset(serverIds: readonly string[]): void {
  console.warn(JSON.stringify({ level: 'warn', event: 'mcp', step: 'endpoint-changed', serverIds }))
}
