import { RunAttribute } from '@goblin/contracts/telemetry'
import * as Cause from 'effect/Cause'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
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
    [RunAttribute.mcpServer]: step.connectionId,
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
 * `effect`, one remote MCP step, reported when it ends: the step, server, tool, outcome and duration. Never arguments,
 * results or credentials. This is how a slow or failing connect or call shows up in the run ledger and the Worker's logs.
 */
export const timed =
  (step: McpStep, report: StepReport = logStep) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(Clock.currentTimeMillis, (started) =>
      Effect.onExit(effect, (exit) =>
        Effect.flatMap(Clock.currentTimeMillis, (ended) =>
          Effect.sync(() =>
            reportSafely(
              report,
              step,
              Exit.isSuccess(exit) ? 'ok' : outcomeOf(Cause.squash(exit.cause)),
              started,
              ended,
            ),
          ),
        ),
      ),
    )

/** One log line per server that lost its credentials and grants because its endpoint changed (ids only). */
export function logEndpointsReset(connectionIds: readonly string[]): void {
  for (const connectionId of connectionIds)
    writeLine('warn', {
      event: 'mcp',
      [RunAttribute.mcpStep]: 'endpoint-changed',
      [RunAttribute.mcpServer]: connectionId,
    })
}
