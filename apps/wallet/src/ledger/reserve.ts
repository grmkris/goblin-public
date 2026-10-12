import { type ApprovalReason, type ApprovalView, type LimitView, type Operation } from '@goblin/wallet/contract'
import * as Schema from 'effect/Schema'
import { LimitView as LimitViewSchema } from '@goblin/wallet/contract'
import { addRecipient, isKnownRecipient } from './book.ts'
import { crossedLimits, currentLimits } from './limits.ts'
import { move, type MoveResult, requireRow } from './operations.ts'
import { type Ctx, getRow, isoOf, isTerminal, type OperationRow, setStatus, toOperation } from './rows.ts'
import { isRevoked } from './state.ts'

/** How long an owner has to answer an approval before the spend expires. */
export const APPROVAL_TTL_MS = 30 * 60_000

type ApprovalStatus = ApprovalView['status']

interface ApprovalRow {
  operation_id: string
  reason: ApprovalReason
  status: ApprovalStatus
  terms_hash: string
  crosses_json: string
  client: string
  remember: number
  created_at_ms: number
  expires_at_ms: number
}

const decodeCrosses = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(LimitViewSchema)))

const getApproval = (ctx: Ctx, id: string): ApprovalRow | undefined =>
  ctx.sql.all<ApprovalRow>('SELECT * FROM approvals WHERE operation_id = ?', id)[0]

function toApprovalView(ctx: Ctx, row: ApprovalRow): ApprovalView {
  const op = toOperation(requireRow(ctx, row.operation_id))
  const lapsed = row.status === 'pending' && row.expires_at_ms <= ctx.now()
  return {
    operationId: row.operation_id,
    reason: row.reason,
    terms: op.terms,
    termsHash: row.terms_hash,
    crosses: decodeCrosses(row.crosses_json),
    client: row.client,
    status: lapsed ? 'expired' : row.status,
    expiresAt: isoOf(row.expires_at_ms),
  }
}

export function approvalView(ctx: Ctx, id: string): ApprovalView | undefined {
  const row = getApproval(ctx, id)
  return row === undefined ? undefined : toApprovalView(ctx, row)
}

export function pendingApprovals(ctx: Ctx): ApprovalView[] {
  return ctx.sql
    .all<ApprovalRow>("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at_ms DESC")
    .map((row) => toApprovalView(ctx, row))
    .filter((view) => view.status === 'pending')
}

export type ReserveOutcome =
  | { kind: 'reserved'; operation: Operation }
  | { kind: 'awaiting_approval'; operation: Operation; approval: ApprovalView }
  | { kind: 'refused'; code: ReserveRefusal; operation: Operation; reason: string }

export type ReserveRefusal =
  | 'unknown_operation'
  | 'revoked'
  | 'grant_expired'
  | 'terms_expired'
  | 'declined'
  | 'approval_expired'
  | 'closed'

export interface ReserveOptions {
  /** Addresses that never need first-use approval (the wallet's own). Lower case. */
  exempt?: readonly string[]
  /** Set by the spend program when the service is not on the allowlist yet. */
  newService?: boolean
}

const refuse = (
  ctx: Ctx,
  id: string,
  code: ReserveRefusal,
  reason: string,
  to?: 'failed' | 'expired',
): ReserveOutcome => {
  if (to !== undefined) setStatus(ctx, id, to, reason)
  return { kind: 'refused', code, reason, operation: toOperation(requireRow(ctx, id)) }
}

const firstUseReason = (ctx: Ctx, row: OperationRow, options: ReserveOptions): ApprovalReason | undefined => {
  if (options.newService === true) return 'new_service'
  const spendsToOutsider = row.kind === 'transfer' || row.kind === 'bridge'
  const terms = toOperation(row).terms
  if (!spendsToOutsider || (options.exempt ?? []).includes(row.recipient)) return undefined
  return isKnownRecipient(ctx, terms.chain, row.recipient) ? undefined : 'new_recipient'
}

function openApproval(ctx: Ctx, row: OperationRow, reason: ApprovalReason, crosses: LimitView[]): ReserveOutcome {
  const now = ctx.now()
  ctx.sql.run(
    `INSERT INTO approvals (operation_id, reason, status, terms_hash, crosses_json, client, created_at_ms, expires_at_ms)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
    row.id,
    reason,
    row.terms_hash,
    JSON.stringify(crosses),
    row.client,
    now,
    now + APPROVAL_TTL_MS,
  )
  setStatus(ctx, row.id, 'awaiting_approval')
  const approval = approvalView(ctx, row.id)
  if (approval === undefined) throw new Error('approval vanished inside a transaction')
  return { kind: 'awaiting_approval', operation: toOperation(requireRow(ctx, row.id)), approval }
}

function reserveNow(ctx: Ctx, id: string): ReserveOutcome {
  ctx.sql.run('UPDATE operations SET reserved_at_ms = ? WHERE id = ?', ctx.now(), id)
  setStatus(ctx, id, 'reserved')
  return { kind: 'reserved', operation: toOperation(requireRow(ctx, id)) }
}

/** What an existing approval says about the spend: undefined means "no decision yet, check the limits". */
function approvalOutcome(ctx: Ctx, row: OperationRow): ReserveOutcome | 'approved' | undefined {
  const approval = getApproval(ctx, row.id)
  if (approval === undefined) return undefined
  if (approval.status === 'declined') return refuse(ctx, row.id, 'declined', 'The owner declined this spend.')
  if (approval.status === 'approved' && approval.terms_hash === row.terms_hash) return 'approved'
  if (approval.expires_at_ms <= ctx.now() || approval.status === 'expired') {
    ctx.sql.run("UPDATE approvals SET status = 'expired' WHERE operation_id = ?", row.id)
    return refuse(ctx, row.id, 'approval_expired', 'The approval request expired.', 'expired')
  }
  const view = toApprovalView(ctx, approval)
  return { kind: 'awaiting_approval', operation: toOperation(row), approval: view }
}

/**
 * Checks the grant and reserves the spend in one transaction. A spend over a limit or to a first-time recipient or
 * service waits for the owner (`awaiting_approval`, no reservation yet); an owner-approved spend reserves on retry
 * without re-asking, but never past a revoked or expired grant. Reserving twice is idempotent.
 */
export function reserve(ctx: Ctx, id: string, options: ReserveOptions = {}): ReserveOutcome {
  return ctx.sql.atomic((): ReserveOutcome => {
    const row = getRow(ctx, id)
    if (row === undefined) throw new Error(`unknown operation ${id}`)
    const op = toOperation(row)
    if (row.reserved_at_ms !== null && !isTerminal(row.status) && row.status !== 'quoted')
      return { kind: 'reserved', operation: op }
    if (row.status !== 'quoted' && row.status !== 'awaiting_approval')
      return refuse(ctx, id, 'closed', `The operation is ${row.status}.`)
    if (isRevoked(ctx)) return refuse(ctx, id, 'revoked', 'The owner revoked this wallet.', 'failed')
    if (currentLimits(ctx).expiresAtMs <= ctx.now())
      return refuse(ctx, id, 'grant_expired', 'The wallet grant expired.', 'failed')
    if (Date.parse(op.terms.expiresAt) <= ctx.now())
      return refuse(ctx, id, 'terms_expired', 'The quote expired.', 'expired')
    const decided = approvalOutcome(ctx, row)
    if (decided === 'approved') return reserveNow(ctx, id)
    if (decided !== undefined) return decided
    const crosses = crossedLimits(ctx, BigInt(row.micros))
    const first = firstUseReason(ctx, row, options)
    const reason: ApprovalReason | undefined = first ?? (crosses.length > 0 ? 'over_limit' : undefined)
    return reason === undefined ? reserveNow(ctx, id) : openApproval(ctx, row, reason, crosses)
  })
}

/**
 * reserved -> signing, the moment before the signer is asked: re-checks, in the same transaction, the grant and the
 * limits as they are now. A reservation made before the grant expired, the quote lapsed or the limits shrank does not
 * sign. A passing reservation is re-admitted under the current window (its hold is re-stamped to now), so a stale
 * reservation cannot sit outside the rolling windows while it spends. An owner-approved spend keeps its approval
 * over the limits, but never past a revoked or expired grant or a lapsed quote.
 */
export function signing(ctx: Ctx, id: string): MoveResult {
  return ctx.sql.atomic((): MoveResult => {
    const row = getRow(ctx, id)
    if (row === undefined || row.status !== 'reserved') return move(ctx, id, 'signing')
    const op = toOperation(row)
    const stop = (code: 'revoked' | 'grant_expired' | 'terms_expired' | 'over_limit', reason: string): MoveResult => {
      setStatus(ctx, id, 'failed', reason)
      return { ok: false, code, reason, operation: toOperation(requireRow(ctx, id)) }
    }
    if (isRevoked(ctx)) return stop('revoked', 'The owner revoked this wallet.')
    if (currentLimits(ctx).expiresAtMs <= ctx.now()) return stop('grant_expired', 'The wallet grant expired.')
    if (Date.parse(op.terms.expiresAt) <= ctx.now()) return stop('terms_expired', 'The quote expired.')
    const approved = getApproval(ctx, id)?.status === 'approved'
    if (!approved && crossedLimits(ctx, BigInt(row.micros), id).length > 0)
      return stop('over_limit', 'The wallet limits no longer have room for this spend.')
    ctx.sql.run('UPDATE operations SET reserved_at_ms = ? WHERE id = ?', ctx.now(), id)
    return move(ctx, id, 'signing')
  })
}

export type DecideResult =
  | { ok: true; approval: ApprovalView }
  | { ok: false; code: 'unknown_approval' | 'terms_changed' | 'not_pending'; approval?: ApprovalView }

export interface Decision {
  decision: 'approve' | 'decline'
  termsHash: string
  remember?: boolean | undefined
}

/** Records the owner's decision, bound to the terms hash they saw. Approving does not reserve; the retry does. */
export function decide(ctx: Ctx, id: string, input: Decision): DecideResult {
  return ctx.sql.atomic((): DecideResult => {
    const row = getApproval(ctx, id)
    if (row === undefined) return { ok: false, code: 'unknown_approval' }
    const view = toApprovalView(ctx, row)
    if (view.status !== 'pending') return { ok: false, code: 'not_pending', approval: view }
    if (row.terms_hash !== input.termsHash) return { ok: false, code: 'terms_changed', approval: view }
    const now = ctx.now()
    const status: ApprovalStatus = input.decision === 'approve' ? 'approved' : 'declined'
    ctx.sql.run(
      'UPDATE approvals SET status = ?, remember = ?, decided_at_ms = ? WHERE operation_id = ?',
      status,
      input.remember === true ? 1 : 0,
      now,
      id,
    )
    if (input.decision === 'decline') setStatus(ctx, id, 'declined', 'The owner declined this spend.')
    else if (input.remember === true) rememberRecipient(ctx, requireRow(ctx, id))
    return { ok: true, approval: toApprovalView(ctx, requireApproval(ctx, id)) }
  })
}

const requireApproval = (ctx: Ctx, id: string): ApprovalRow => {
  const row = getApproval(ctx, id)
  if (row === undefined) throw new Error('approval vanished inside a transaction')
  return row
}

function rememberRecipient(ctx: Ctx, row: OperationRow): void {
  const terms = toOperation(row).terms
  addRecipient(ctx, terms.chain, row.recipient, terms.subject)
}
