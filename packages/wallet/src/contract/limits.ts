import * as Schema from 'effect/Schema'
import { ChainKey, Instant, Text, UsdAmount } from './ids.ts'

/**
 * Which layer enforces a limit. Every limit the wallet shows names its layer, so the owner sees what is a promise of
 * this service and what the chain or the signer enforces whatever this service does.
 * - `onchain`: an ERC-7710 period allowance redeemed through the MetaMask DelegationManager.
 * - `tempo`: a Tempo access key's spending limit, enforced by the Tempo protocol.
 * - `signer`: the Privy policy on the agent signer (per-payment cap, allowed contracts, no key export).
 * - `ledger`: this wallet's own ledger (per call, per hour, per week, allowlist, address book).
 * - `client`: a narrower rule the MCP client keeps (e.g. goblin's spending rules); shown only when reported.
 */
export const LimitLayer = Schema.Literals(['onchain', 'tempo', 'signer', 'ledger', 'client'])
export type LimitLayer = typeof LimitLayer.Type

export const LimitPeriod = Schema.Literals(['call', 'hour', 'day', 'week', 'total'])
export type LimitPeriod = typeof LimitPeriod.Type

/** One limit as the owner and the model see it. Amounts are USD decimal strings. */
export const LimitView = Schema.Struct({
  layer: LimitLayer,
  period: LimitPeriod,
  limit: UsdAmount,
  used: Schema.optional(UsdAmount),
  remaining: Schema.optional(UsdAmount),
  chain: Schema.optional(ChainKey),
  /** One line saying who enforces it, e.g. "Base, MetaMask ERC20PeriodTransfer enforcer". */
  enforcedBy: Text(160),
  periodEndsAt: Schema.optional(Instant),
})
export type LimitView = typeof LimitView.Type

/** The owner-set ledger limits of one grant (R14 defaults: $5 a call, $20 an hour, $50 a week, 7 days). */
export const WalletLimits = Schema.Struct({
  perCall: UsdAmount,
  perHour: UsdAmount,
  perWeek: UsdAmount,
  expiresAt: Instant,
  version: Schema.Int.check(Schema.isGreaterThan(0)),
})
export type WalletLimits = typeof WalletLimits.Type

export const DEFAULT_LIMITS = { perCall: '5', perHour: '20', perWeek: '50' } as const
export const DEFAULT_GRANT_DAYS = 7
