import { RunAttribute, type RunEvent } from '@goblin/contracts/telemetry'
import { expectedFailure } from './safety.ts'

/** A user-facing answer can need attention even when the provider accepted the request and Pi settled the turn. */
export const incompleteAnswer = (event: RunEvent): boolean =>
  (event.kind === 'model.attempt' &&
    (event.attributes[RunAttribute.cutoff] === true ||
      event.attributes[RunAttribute.finishReason] === 'length' ||
      event.attributes[RunAttribute.emptyAnswer] === true)) ||
  event.attributes[RunAttribute.coverageGap] === true

/** Hide only a confirmed automatic model retry, never an arbitrary tool failure in a successful turn. */
export function needsAttention(event: RunEvent, peers: readonly RunEvent[]): boolean {
  if (incompleteAnswer(event)) return true
  if (expectedFailure(event.attributes[RunAttribute.errorType])) return false
  if (event.status === 'ok' || event.status === 'started') return false
  if (event.kind !== 'model.attempt' || event.taskId === undefined || event.operationId === undefined) return true
  if (
    event.status === 'interrupted' &&
    (event.attributes[RunAttribute.finishReason] === 'aborted' || event.attributes[RunAttribute.reason] === 'aborted')
  )
    return true
  return !peers.some(
    (later) =>
      later.kind === 'model.attempt' &&
      later.taskId === event.taskId &&
      later.operationId === event.operationId &&
      later.id !== event.id &&
      later.status === 'ok' &&
      later.startedAt >= (event.endedAt ?? event.startedAt) &&
      !incompleteAnswer(later),
  )
}
