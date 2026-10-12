import * as Schema from 'effect/Schema'
import { Address, ChainKey, OperationId, Text, TokenAmount, UsdAmount } from './ids.ts'
import { LimitView } from './limits.ts'
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

/**
 * `pay_challenge`, which only goblin's runtime calls (the tool is hidden from the model). To pay: the request's `url`
 * and `method`, `challenge` (the service's raw `WWW-Authenticate` value), `max_usd` and `operation_id`; the wallet signs
 * the Tempo USDC.e charge and answers `{ credential }`, which the caller sends as `Authorization: Payment <credential>`.
 * To report the outcome: the same `operation_id` and `receipt` (the service's `Payment-Receipt` value) alone.
 */
export const PayChallengeInput = Schema.Struct({
  operation_id: OperationId,
  url: Schema.optional(Text(2048)),
  method: Schema.optional(Schema.Literals(['GET', 'POST'])),
  challenge: Schema.optional(Text(8192)),
  max_usd: Schema.optional(UsdAmount),
  receipt: Schema.optional(Text(4096)),
})
export type PayChallengeInput = typeof PayChallengeInput.Type

/**
 * What `pay_challenge` answers: the operation, and when paying, the credential (the token after `Payment `, valid for
 * about 25 seconds after it was signed). A receipt report says whether the chain showed the payment (`paid`) or not
 * yet (`unknown`, the operation stays uncertain).
 */
export const PayChallengeResult = Schema.Struct({
  operation: Operation,
  credential: Schema.optional(Text(8192)),
  found: Schema.optional(Schema.Literals(['paid', 'unknown'])),
})
export type PayChallengeResult = typeof PayChallengeResult.Type

export const OperationInput = Schema.Struct({ operation_id: OperationId })
export type OperationInput = typeof OperationInput.Type

/**
 * `operation_check` and `POST /api/operations/:operationId/check`: what the chain said about an operation whose outcome
 * was unknown, and the operation as it stands now. `paid` and `not_paid` moved it; `unknown` left it as it was; `known`
 * means its outcome was already settled and nothing was read. Checking never pays.
 */
export const OperationCheck = Schema.Struct({
  operation: Operation,
  found: Schema.Literals(['paid', 'not_paid', 'unknown', 'known']),
  note: Text(240),
})
export type OperationCheck = typeof OperationCheck.Type

/**
 * `POST /api/deposits` and the `add_funds` tool: a one-off Relay deposit address. Whatever is sent there from `from`, in
 * `asset`, arrives as `receive`, usually within seconds: `USDC.e` in the agent's wallet on Tempo (what it pays MPP
 * services and paid inference with), `ETH` or `USDC` in the owner's account on Base. The address serves this quote only.
 */
export const DepositRequest = Schema.Struct({
  from: Schema.Literals(['base', 'arbitrum', 'ethereum']),
  asset: Schema.Literals(['ETH', 'USDC']),
  /** Decimal amount of `asset` the sender will send. */
  amount: TokenAmount,
  receive: Schema.Literals(['ETH', 'USDC', 'USDC.e']),
})
export type DepositRequest = typeof DepositRequest.Type

/** `wallet_open` and `wallet_home`: `focus` opens the App on that part, e.g. Add funds for an owner who must fund it. */
export const WalletOpenInput = Schema.Struct({ focus: Schema.optional(Schema.Literal('add_funds')) })
export type WalletOpenInput = typeof WalletOpenInput.Type

/**
 * `add_funds`: a one-off Relay deposit address (`DepositRequest`). `receive` defaults to `USDC.e`, which lands in the
 * agent's wallet on Tempo, where paid inference and MPP services are paid from. Nothing is signed or spent.
 */
export const AddFundsInput = Schema.Struct({
  from: DepositRequest.fields.from,
  asset: DepositRequest.fields.asset,
  amount: DepositRequest.fields.amount,
  receive: Schema.optional(DepositRequest.fields.receive),
})
export type AddFundsInput = typeof AddFundsInput.Type

/** `add_funds_status`: Relay's progress for a deposit address `add_funds` gave. */
export const AddFundsStatusInput = Schema.Struct({ deposit_address: Address })
export type AddFundsStatusInput = typeof AddFundsStatusInput.Type

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
  /** When the operation is quoted or awaits approval: the absolute https URL of its Approve page. */
  approveUrl: Schema.optional(Text(2048)),
  /** The limits left after this operation, with their layers. */
  limits: Schema.optional(Schema.Array(LimitView)),
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
  payChallenge: 'pay_challenge',
  transfer: 'transfer',
  swapQuote: 'swap_quote',
  swapExecute: 'swap_execute',
  bridgeQuote: 'bridge_quote',
  bridgeExecute: 'bridge_execute',
  operation: 'operation',
  operationCheck: 'operation_check',
  receipt: 'receipt',
  policyChange: 'request_policy_change',
  viewState: 'view_state',
  addFunds: 'add_funds',
  addFundsStatus: 'add_funds_status',
} as const
