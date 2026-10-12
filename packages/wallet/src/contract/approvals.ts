import * as Schema from 'effect/Schema'
import { Hex, Instant, OperationId, Text } from './ids.ts'
import { LimitView } from './limits.ts'
import { Terms } from './operations.ts'

/** Why a spend waits for the owner. */
export const ApprovalReason = Schema.Literals(['over_limit', 'new_recipient', 'new_service', 'policy_change'])
export type ApprovalReason = typeof ApprovalReason.Type

/** What `/approve/:operationId` shows. The page rebuilds `termsHash` from `terms` before the owner can approve. */
export const ApprovalView = Schema.Struct({
  operationId: OperationId,
  reason: ApprovalReason,
  terms: Terms,
  termsHash: Hex,
  /** Which limits the spend would cross, with their layer. */
  crosses: Schema.Array(LimitView),
  /** The MCP client that asked, as the owner named its connection. */
  client: Text(120),
  status: Schema.Literals(['pending', 'approved', 'declined', 'expired']),
  expiresAt: Instant,
})
export type ApprovalView = typeof ApprovalView.Type

/** `POST /api/approvals/:operationId`: the owner's decision, bound to the terms hash they saw. */
export const ApprovalDecision = Schema.Struct({
  decision: Schema.Literals(['approve', 'decline']),
  termsHash: Hex,
  /** Also remember this recipient or service in the address book / allowlist. */
  remember: Schema.optional(Schema.Boolean),
})
export type ApprovalDecision = typeof ApprovalDecision.Type
