import * as Schema from 'effect/Schema'
import { Address, ChainKey, Instant, Text, TokenAmount } from './ids.ts'
import { LimitView } from './limits.ts'
import { Operation } from './operations.ts'

const Readiness = Schema.Literals(['ready', 'blocked', 'not_verified'])
const Short = Schema.String.check(Schema.isMaxLength(64))

/**
 * The part of `wallet_status` goblin's first-class profile reads (goblin's `WalletStatus`, ADR 0043): readiness, each
 * token's balance, what its limit has left and can spend now, when the period ends, when the grant expires, and the
 * stablecoin dollars held. Keep it this shape (goblin mirrors it); extra fields live beside it in `WalletStatusResult`.
 */
export const WalletStatus = Schema.Struct({
  kind: Schema.Literal('wallet'),
  paid: Readiness,
  funding: Readiness,
  tokens: Schema.Array(
    Schema.Struct({
      symbol: Short,
      balance: Schema.optional(Short),
      remaining: Schema.optional(Short),
      spendable: Schema.optional(Short),
    }),
  ).check(Schema.isMaxLength(8)),
  periodEndsAt: Schema.optional(Short),
  expiresAt: Schema.optional(Short),
  /**
   * The dollar stablecoins (USDC, USDC.e, pathUSD) the owner and the agent hold on every chain that was read, a decimal
   * string. Absent when no chain could be read.
   */
  stablecoinUsd: Schema.optional(Short),
  /** Set when some chain could not be read: `stablecoinUsd` counts only the chains that answered, so it may be more. */
  stablecoinUsdPartial: Schema.optional(Schema.Literal(true)),
})
export type WalletStatus = typeof WalletStatus.Type

/** One token balance on one chain. `spendable` is what the agent may spend now under every layer. */
export const ChainBalance = Schema.Struct({
  chain: ChainKey,
  symbol: Text(16),
  token: Address,
  decimals: Schema.Int,
  balance: TokenAmount,
  /** Who holds it: the owner's account (allowance source) or the agent's own signer wallet. */
  holder: Schema.Literals(['owner', 'agent']),
  address: Address,
})
export type ChainBalance = typeof ChainBalance.Type

/**
 * The address paid inference and MPP services are paid from: the agent's own wallet, on Tempo, in USDC.e. Sending
 * USDC.e there on Tempo (or through `add_funds` from another chain) funds it. `held` is absent when Tempo was not read.
 */
export const PayFrom = Schema.Struct({
  address: Address,
  chain: Schema.Literal('tempo'),
  token: Schema.Literal('USDC.e'),
  held: Schema.optional(TokenAmount),
})
export type PayFrom = typeof PayFrom.Type

/**
 * The agent's Tempo float (ADR 0051): its USDC.e on Tempo, which the wallet refills from the owner's Base allowance to
 * `target` whenever it falls below `low`. `automatic` is false when the allowance cannot refill it (none, expired, used
 * up this period, nothing on Base, or testnets): then the owner funds Tempo by hand. `held` is absent when Tempo was
 * not read.
 */
export const TempoFloat = Schema.Struct({
  held: Schema.optional(TokenAmount),
  low: TokenAmount,
  target: TokenAmount,
  refilling: Schema.Boolean,
  automatic: Schema.Boolean,
})
export type TempoFloat = typeof TempoFloat.Type

/** `wallet_status` structured content: goblin's `WalletStatus` plus what the App shows. */
export const WalletStatusResult = Schema.Struct({
  status: WalletStatus,
  owner: Schema.Struct({ address: Address, upgraded: Schema.Boolean }),
  agent: Schema.Struct({ address: Address }),
  /** Absent until the owner has created the agent wallet. */
  payFrom: Schema.optional(PayFrom),
  /** Absent until the owner has created the agent wallet. */
  float: Schema.optional(TempoFloat),
  balances: Schema.Array(ChainBalance),
  /** Chains whose balances could not be read just now: unknown, never zero. Their rows are absent from `balances`. */
  unread: Schema.optional(Schema.Array(ChainKey)),
  limits: Schema.Array(LimitView),
  /** The latest operations, newest first, for the App's activity list. */
  recent: Schema.optional(Schema.Array(Operation).check(Schema.isMaxLength(10))),
  /** The owner's wallet app, where a waiting spend is approved (`/approve/<operation id>`) and limits are changed. */
  site: Schema.optional(Text(256)),
  /** The App opens on this part when the caller asked for it (`wallet_open` with `focus`). */
  focus: Schema.optional(Schema.Literal('add_funds')),
  checkedAt: Instant,
})
export type WalletStatusResult = typeof WalletStatusResult.Type
