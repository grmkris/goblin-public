import * as Schema from 'effect/Schema'

/** Pi submission identifiers cross the browser boundary as positive safe integers. */
export const SubmissionId = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
export const QueuedInput = Schema.Struct({
  id: SubmissionId,
  mode: Schema.Literals(['steer', 'followUp']),
  content: Schema.Json,
})
export type QueuedInput = typeof QueuedInput.Type

/** Queued inputs only, in Pi order; passive writes and helper/routine queues stay outside this owner view. */
export const ConversationQueue = Schema.Struct({ inputs: Schema.Array(QueuedInput) })
export type ConversationQueue = typeof ConversationQueue.Type

export const QueueRemoval = Schema.Struct({ submissionId: SubmissionId })
export type QueueRemoval = typeof QueueRemoval.Type
export const QueueRemovalResult = Schema.Struct({
  status: Schema.Literals(['removed', 'already_started', 'already_settled', 'not_found']),
})
export type QueueRemovalResult = typeof QueueRemovalResult.Type
