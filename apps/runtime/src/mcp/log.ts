import { RunAttribute } from '@goblin/contracts/telemetry'
import { nowMillis } from '../clock.ts'
import { writeLine } from '../observability/logger.ts'
import { safeErrorType } from '../observability/report.ts'
import { outcomeOf } from '../telemetry/attributes.ts'
import { expectedFailure, safeFailureCode } from '../telemetry/safety.ts'
import type { McpStep } from '../telemetry/report.ts'

/** Where a finished MCP step goes: the run telemetry (`mcpReporter`), or a plain log line. */
export type StepReport = (step: McpStep, outcome: string, startedAt: number, endedAt: number) => void

/** One `mcp` log line per step, for a manager made without run telemetry: ids, outcome and duration only. */
const logStep: StepReport = (step, outcome, startedAt, endedAt) => {
  const code = outcome === 'ok' ? 'ok' : safeFailureCode(outcome)
  writeLine(outcome === 'ok' || expectedFailure(code) ? 'info' : 'warn', {
    event: 'mcp',
    [RunAttribute.mcpStep]: step.step,
    [RunAttribute.mcpServer]: step.serverId,
    ...(step.tool === undefined ? {} : { [RunAttribute.mcpTool]: step.tool }),
    ...(step.method === undefined ? {} : { [RunAttribute.mcpMethod]: step.method }),
    ...(step.sharedConnection === undefined ? {} : { [RunAttribute.sharedConnection]: step.sharedConnection }),
    code,
    ms: endedAt - startedAt,
  })
}

/** A sink that failed is reported and never fails the step it was told about. */
const reportSafely = (report: StepReport, step: McpStep, outcome: string, startedAt: number, endedAt: number): void => {
  try {
    report(step, outcome, startedAt, endedAt)
  } catch (error) {
    writeLine('warn', { event: 'failure', where: 'mcp.report', 'error.type': safeErrorType(error) })
  }
}

/**
 * Runs one remote MCP step and reports it: the step, server, tool, outcome and duration. Never arguments, results or
 * credentials. This is how a slow or failing connect or call shows up in the run ledger and the Worker's logs.
 */
export async function timed<T>(step: McpStep, work: () => Promise<T>, report: StepReport = logStep): Promise<T> {
  const started = nowMillis()
  try {
    const value = await work()
    reportSafely(report, step, 'ok', started, nowMillis())
    return value
  } catch (error) {
    reportSafely(report, step, outcomeOf(error), started, nowMillis())
    throw error
  }
}

/** One log line per server that lost its credentials and grants because its endpoint changed (ids only). */
export function logEndpointsReset(serverIds: readonly string[]): void {
  for (const serverId of serverIds)
    writeLine('warn', { event: 'mcp', [RunAttribute.mcpStep]: 'endpoint-changed', [RunAttribute.mcpServer]: serverId })
}
