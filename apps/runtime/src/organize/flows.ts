import type { FlowEvent } from '@goblin/contracts/telemetry'
import { FlowEvents } from '../observability/flows.ts'
import { EXPECTED_ERROR_TAGS, safeErrorType } from '../observability/report.ts'

/** Records one step of a conversation flow (plan §4, ADR 0024); recording never fails the flow it describes. */
export const recordFlow = (event: FlowEvent) => FlowEvents.use((flows) => flows.record(event))

/**
 * How a flow that failed with `error` ended: `refused` for a typed refusal the caller is answered with (a 404, a 409),
 * `error` for anything else. Only the failure's type is kept, never its text.
 */
export const failedFlow = (error: unknown): Pick<FlowEvent, 'status' | 'errorType'> => {
  const errorType = safeErrorType(error)
  return { status: EXPECTED_ERROR_TAGS.has(errorType) ? 'refused' : 'error', errorType }
}

/** Where an organizing change came in: the owner's app, or the agent's organize tools. */
export const viaOf = (actor: 'owner' | 'agent'): FlowEvent['via'] => (actor === 'owner' ? 'app' : 'tool')
