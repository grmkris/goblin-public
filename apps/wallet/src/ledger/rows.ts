import { type Operation, type OperationStatus, Payment, Terms } from '@goblin/wallet/contract'
import * as Schema from 'effect/Schema'
import type { Sql } from './sql.ts'

/** What the ledger needs to read and write: its storage and a clock (milliseconds), injected so tests control time. */
export interface Ctx {
  readonly sql: Sql
  readonly now: () => number
}

/** Statuses whose reservation still counts against the rolling windows. `uncertain` keeps its reservation. */
export const COUNTED: readonly OperationStatus[] = [
  'reserved',
  'signing',
  'submitted',
  'confirmed',
  'delivered',
  'uncertain',
]
export const COUNTED_SQL = COUNTED.map((status) => `'${status}'`).join(',')

const TERMINAL: readonly OperationStatus[] = ['delivered', 'failed', 'expired', 'declined', 'cancelled']
export const isTerminal = (status: OperationStatus): boolean => TERMINAL.includes(status)

/** Allowed status moves. Anything else is a bug in the caller and is refused, never applied. */
const MOVES: Readonly<Record<OperationStatus, readonly OperationStatus[]>> = {
  quoted: ['awaiting_approval', 'reserved', 'failed', 'cancelled', 'expired'],
  awaiting_approval: ['reserved', 'declined', 'expired', 'cancelled'],
  reserved: ['signing', 'failed', 'cancelled'],
  signing: ['submitted', 'confirmed', 'delivered', 'failed', 'uncertain'],
  submitted: ['confirmed', 'delivered', 'failed', 'uncertain'],
  confirmed: ['delivered', 'uncertain'],
  uncertain: ['confirmed', 'delivered', 'failed'],
  delivered: [],
  failed: [],
  expired: [],
  declined: [],
  cancelled: [],
}
export const canMove = (from: OperationStatus, to: OperationStatus): boolean => MOVES[from].includes(to)

export interface OperationRow {
  id: string
  kind: string
  status: OperationStatus
  terms_json: string
  terms_hash: string
  args_hash: string
  micros: number
  limits_version: number
  recipient: string
  client: string
  payment_json: string | null
  delivery_json: string | null
  reason: string | null
  reserved_at_ms: number | null
  created_at_ms: number
  updated_at_ms: number
}

const Delivery = Schema.Struct({
  status: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  detail: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240))),
})
const decodeTerms = Schema.decodeUnknownSync(Schema.fromJsonString(Terms))
const decodePayment = Schema.decodeUnknownSync(Schema.fromJsonString(Payment))
const decodeDelivery = Schema.decodeUnknownSync(Schema.fromJsonString(Delivery))
const iso = (ms: number): string => new Date(ms).toISOString()
export const isoOf = iso

export function toOperation(row: OperationRow): Operation {
  return {
    id: row.id,
    status: row.status,
    terms: decodeTerms(row.terms_json),
    termsHash: row.terms_hash,
    limitsVersion: row.limits_version,
    ...(row.payment_json === null ? {} : { payment: decodePayment(row.payment_json) }),
    ...(row.delivery_json === null ? {} : { delivery: decodeDelivery(row.delivery_json) }),
    ...(row.reason === null ? {} : { reason: row.reason }),
    createdAt: iso(row.created_at_ms),
    updatedAt: iso(row.updated_at_ms),
  }
}

export function getRow(ctx: Ctx, id: string): OperationRow | undefined {
  return ctx.sql.all<OperationRow>('SELECT * FROM operations WHERE id = ?', id)[0]
}

export function setStatus(ctx: Ctx, id: string, status: OperationStatus, reason?: string): void {
  ctx.sql.run(
    'UPDATE operations SET status = ?, reason = COALESCE(?, reason), updated_at_ms = ? WHERE id = ?',
    status,
    reason ?? null,
    ctx.now(),
    id,
  )
}
