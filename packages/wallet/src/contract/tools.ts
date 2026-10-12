import * as Schema from 'effect/Schema'
import { Address, ChainKey, OperationId, Text, TokenAmount, UsdAmount } from './ids.ts'
import { Operation } from './operations.ts'

/**
 * MCP tool inputs. Every paid or signing tool takes an `operation_id` (the same id finds the same operation and never
 * pays twice) and, when it can spend, `max_usd` as a plain decimal string: the most the caller agrees to pay. goblin's
 * first-class profile reads `paid_fetch.max_usd` for its spending rules (ADR 0044).
 */
export const PaidFetchInput = Schema.Struct({
  service: Text(64),
  /** The request body (JSON) for POST services, or query parameters for GET ones. */
  args: Schema.Record(Schema.String, Schema.Unknown),
  max_usd: UsdAmount,
  operation_id: OperationId,
  /** Prefer a rail; the wallet picks the cheapest allowed one otherwise. */
  rail: Schema.optional(Schema.Literals(['x402', 'mpp'])),
})
export type PaidFetchInput = typeof PaidFetchInput.Type

export const TransferInput = Schema.Struct({
  chain: ChainKey,
  token: Text(16),
  to: Address,
  amount: TokenAmount,
  max_usd: UsdAmount,
  operation_id: OperationId,
  memo: Schema.optional(Text(120)),
})
export type TransferInput = typeof TransferInput.Type

export const SwapQuoteInput = Schema.Struct({
  chain: ChainKey,
  sell: Text(16),
  buy: Text(16),
  amount: TokenAmount,
})
export type SwapQuoteInput = typeof SwapQuoteInput.Type

export const BridgeQuoteInput = Schema.Struct({
  from: ChainKey,
  to: ChainKey,
  token: Text(16),
  amount: TokenAmount,
  /** Destination address; defaults to the agent's own address on the destination chain. */
  recipient: Schema.optional(Address),
})
export type BridgeQuoteInput = typeof BridgeQuoteInput.Type

/** Executes a frozen quote: the operation's terms are the quote's, never re-derived from new arguments. */
export const ExecuteQuoteInput = Schema.Struct({
  quote_id: Text(128),
  max_usd: UsdAmount,
  operation_id: OperationId,
})
export type ExecuteQuoteInput = typeof ExecuteQuoteInput.Type

export const OperationInput = Schema.Struct({ operation_id: OperationId })
export type OperationInput = typeof OperationInput.Type

export const PolicyChangeInput = Schema.Struct({
  /** What the agent asks for, e.g. raise the hourly limit to $30, or allow a new service. */
  change: Text(400),
  reason: Text(400),
})
export type PolicyChangeInput = typeof PolicyChangeInput.Type

/** A quote: frozen terms the caller can execute until it expires. */
export const Quote = Schema.Struct({
  quote_id: Text(128),
  summary: Text(240),
  amountUsd: UsdAmount,
  feesUsd: Schema.optional(UsdAmount),
  minimumReceived: Schema.optional(TokenAmount),
  expiresAt: Text(40),
})
export type Quote = typeof Quote.Type

/** What every spending tool returns: the operation, and for paid_fetch the bounded response of the paid request. */
export const SpendResult = Schema.Struct({
  operation: Operation,
  response: Schema.optional(
    Schema.Struct({ status: Schema.Int, contentType: Text(120), body: Schema.Unknown, truncated: Schema.Boolean }),
  ),
})
export type SpendResult = typeof SpendResult.Type

/** The tool names, in one place for the server, the App and goblin's profile. */
export const TOOLS = {
  status: 'wallet_status',
  open: 'wallet_open',
  openGlobal: 'wallet_home',
  balances: 'balances',
  allowances: 'allowances',
  services: 'services',
  paidFetch: 'paid_fetch',
  transfer: 'transfer',
  swapQuote: 'swap_quote',
  swapExecute: 'swap_execute',
  bridgeQuote: 'bridge_quote',
  bridgeExecute: 'bridge_execute',
  operation: 'operation',
  receipt: 'receipt',
  policyChange: 'request_policy_change',
  viewState: 'view_state',
} as const
