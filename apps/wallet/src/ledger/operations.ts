import type { Operation, OperationStatus, Payment, Terms } from '@goblin/wallet/contract'
import { usdToMicros } from '@goblin/wallet/amounts'
import { currentLimits } from './limits.ts'
import { type Ctx, canMove, getRow, type OperationRow, setStatus, toOperation } from './rows.ts'
import { isRevoked } from './state.ts'

export type BeginResult =
  | { kind: 'created' | 'replay'; operation: Operation }
  | { kind: 'conflict'; operation: Operation }
  | { kind: 'refused'; code: 'revoked'; reason: string }

export interface BeginInput {
  id: string
  argsHash: string
  terms: Terms
  termsHash: string
  /** The MCP client's name, for the approval page. */
  client: string
}

export type LookupResult = { kind: 'none' } | { kind: 'replay' | 'conflict'; operation: Operation }

/** Finds an operation by id and says whether the arguments match the ones it was created with. */
export function lookup(ctx: Ctx, id: string, argsHash: string): LookupResult {
  const row = getRow(ctx, id)
  if (row === undefined) return { kind: 'none' }
  return { kind: row.args_hash === argsHash ? 'replay' : 'conflict', operation: toOperation(row) }
}

/** Creates a `quoted` operation with frozen terms. The same id and args replays; a different args hash conflicts. */
export function begin(ctx: Ctx, input: BeginInput): BeginResult {
  return ctx.sql.atomic((): BeginResult => {
    const existing = lookup(ctx, input.id, input.argsHash)
    if (existing.kind !== 'none') return existing
    if (isRevoked(ctx)) return { kind: 'refused', code: 'revoked', reason: 'The owner revoked this wallet.' }
    const now = ctx.now()
    ctx.sql.run(
      `INSERT INTO operations (id, kind, status, terms_json, terms_hash, args_hash, micros, limits_version,
        recipient, client, created_at_ms, updated_at_ms) VALUES (?, ?, 'quoted', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.terms.kind,
      JSON.stringify(input.terms),
      input.termsHash,
      input.argsHash,
      Number(usdToMicros(input.terms.amountUsd)),
      currentLimits(ctx).version,
      input.terms.recipient.toLowerCase(),
      input.client,
      now,
      now,
    )
    return { kind: 'created', operation: toOperation(requireRow(ctx, input.id)) }
  })
}

export function requireRow(ctx: Ctx, id: string): OperationRow {
  const row = getRow(ctx, id)
  if (row === undefined) throw new Error(`operation ${id} vanished inside a transaction`)
  return row
}

export type MoveResult =
  | { ok: true; operation: Operation }
  | { ok: false; code: 'unknown_operation' | 'bad_transition'; operation?: Operation }

export interface MovePatch {
  payment?: Payment
  delivery?: { status: string; detail?: string }
  reason?: string
}

/** Moves an operation to `to` if the state machine allows it, recording the payment, delivery and reason. */
export function move(ctx: Ctx, id: string, to: OperationStatus, patch: MovePatch = {}): MoveResult {
  return ctx.sql.atomic((): MoveResult => {
    const row = getRow(ctx, id)
    if (row === undefined) return { ok: false, code: 'unknown_operation' }
    if (!canMove(row.status, to)) return { ok: false, code: 'bad_transition', operation: toOperation(row) }
    setStatus(ctx, id, to, patch.reason)
    if (patch.payment !== undefined)
      ctx.sql.run('UPDATE operations SET payment_json = ? WHERE id = ?', JSON.stringify(patch.payment), id)
    if (patch.delivery !== undefined)
      ctx.sql.run('UPDATE operations SET delivery_json = ? WHERE id = ?', JSON.stringify(patch.delivery), id)
    return { ok: true, operation: toOperation(requireRow(ctx, id)) }
  })
}

export function getOperation(ctx: Ctx, id: string): Operation | undefined {
  const row = getRow(ctx, id)
  return row === undefined ? undefined : toOperation(row)
}

/** Newest first. */
export function activity(ctx: Ctx, limit: number): Operation[] {
  return ctx.sql
    .all<OperationRow>('SELECT * FROM operations ORDER BY created_at_ms DESC, id DESC LIMIT ?', limit)
    .map(toOperation)
}
