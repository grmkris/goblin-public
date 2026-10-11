import { RunAttribute } from '@goblin/contracts/telemetry'
import { nowMillis } from '../clock.ts'
import { type Answer, answerAttributes, failureAttributes, statusOfStop } from './attributes.ts'
import type { RunTelemetry } from './events.ts'
import { expectedFailure, safeFailureCode } from './safety.ts'

/** A model call made outside a turn: its response, or the error it threw. */
export type AuxCall = { readonly startedAt: number; readonly message?: Answer; readonly error?: unknown }

/** What a model call outside a turn was for (ADR 0024). */
export type AuxPurpose = 'naming' | 'memory' | 'skill' | 'app_llm' | 'retrieval' | 'decision'

/** Records each cheap-model call for `purpose` as one `model.aux` event. */
export const auxReporter =
  (telemetry: RunTelemetry, purpose: AuxPurpose) =>
  (call: AuxCall): void => {
    try {
      recordAux(telemetry, purpose, call)
    } catch {
      // expected: a malformed response is the model's problem, not the caller's; the call goes on unrecorded.
    }
  }

function recordAux(telemetry: RunTelemetry, purpose: AuxPurpose, call: AuxCall): void {
  const endedAt = nowMillis()
  const outcome =
    call.message === undefined
      ? { status: 'error' as const, attributes: failureAttributes(call.error) }
      : { status: statusOfStop(call.message.stopReason), attributes: answerAttributes(call.message) }
  telemetry.record({
    id: telemetry.id('aux', call.startedAt),
    kind: 'model.aux',
    status: outcome.status,
    startedAt: call.startedAt,
    endedAt,
    attributes: { [RunAttribute.operation]: 'chat', [RunAttribute.purpose]: purpose, ...outcome.attributes },
  })
}

/** One remote MCP step (mcp/log.ts): which, on which server, how it ended and when. */
export type McpStep = {
  readonly step: 'connect' | 'call' | 'skills' | 'events'
  readonly connectionId: string
  readonly tool?: string
  readonly method?: string
  readonly scope?: { readonly conversationId: string; readonly taskId: string }
  readonly sharedConnection?: boolean
}

/** Records each remote MCP step as one `mcp.request` event. */
export const mcpReporter =
  (telemetry: RunTelemetry) =>
  (step: McpStep, outcome: string, startedAt: number, endedAt: number): void => {
    const code = safeFailureCode(outcome)
    telemetry.record({
      id: telemetry.id('mcp', startedAt),
      kind: 'mcp.request',
      ...(step.scope === undefined ? {} : telemetry.scopeOf(step.scope)),
      status: outcome === 'ok' ? 'ok' : expectedFailure(code) ? 'blocked' : 'error',
      startedAt,
      endedAt,
      attributes: {
        [RunAttribute.mcpStep]: step.step,
        [RunAttribute.mcpServer]: step.connectionId,
        ...(step.sharedConnection === true ? { [RunAttribute.sharedConnection]: true } : {}),
        ...(step.tool === undefined ? {} : { [RunAttribute.mcpTool]: step.tool }),
        ...(step.method === undefined ? {} : { [RunAttribute.mcpMethod]: step.method }),
        ...(outcome === 'ok' ? {} : { [RunAttribute.errorType]: code }),
      },
    })
  }
