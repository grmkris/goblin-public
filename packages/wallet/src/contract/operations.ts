import * as Schema from 'effect/Schema'
import { Address, ChainKey, Hex, Instant, OperationId, Text, TokenAmount, UsdAmount } from './ids.ts'

export const OperationKind = Schema.Literals(['paid_fetch', 'transfer', 'swap', 'bridge', 'upgrade', 'allowance'])
export type OperationKind = typeof OperationKind.Type

/** The rail a payment went over. */
export const Rail = Schema.Literals(['x402', 'mpp', 'transfer', 'lifi', 'relay', 'delegation'])
export type Rail = typeof Rail.Type

/**
 * An operation's state. Payment and delivery are separate: a confirmed payment can still have a pending or failed
 * delivery. `uncertain` keeps its reservation until reconciled and is never retried automatically.
 */
export const OperationStatus = Schema.Literals([
  'quoted',
  'awaiting_approval',
  'reserved',
  'signing',
  'submitted',
  'confirmed',
  'delivered',
  'failed',
  'uncertain',
  'expired',
  'declined',
  'cancelled',
])
export type OperationStatus = typeof OperationStatus.Type

/** The frozen terms of a spend: what approval binds to. `termsHash` is sha-256 of their canonical JSON. */
export const Terms = Schema.Struct({
  kind: OperationKind,
  chain: ChainKey,
  rail: Rail,
  /** The service id (paid_fetch) or a short label of the action. */
  subject: Text(120),
  token: Schema.Struct({ symbol: Text(16), address: Address, decimals: Schema.Int }),
  amount: TokenAmount,
  amountUsd: UsdAmount,
  recipient: Address,
  /** For paid_fetch: the exact request (method + https URL) the payment buys. */
  request: Schema.optional(Schema.Struct({ method: Text(8), url: Text(2048) })),
  expiresAt: Instant,
})
export type Terms = typeof Terms.Type

export const Payment = Schema.Struct({
  rail: Rail,
  txHash: Schema.optional(Hex),
  /** The rail's own receipt reference (x402 PAYMENT-RESPONSE, MPP Payment-Receipt), bounded. */
  reference: Schema.optional(Text(512)),
  explorerUrl: Schema.optional(Text(256)),
  settledAt: Schema.optional(Instant),
})
export type Payment = typeof Payment.Type

export const Operation = Schema.Struct({
  id: OperationId,
  status: OperationStatus,
  terms: Terms,
  termsHash: Hex,
  /** The ledger version the operation was checked against. */
  limitsVersion: Schema.Int,
  payment: Schema.optional(Payment),
  /** Bounded delivery note, e.g. an HTTP status of the paid request; never the paid content itself. */
  delivery: Schema.optional(Schema.Struct({ status: Text(32), detail: Schema.optional(Text(240)) })),
  /** Why it failed or was refused, for the owner and the model. */
  reason: Schema.optional(Text(240)),
  createdAt: Instant,
  updatedAt: Instant,
})
export type Operation = typeof Operation.Type
