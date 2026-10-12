import * as Schema from 'effect/Schema'
import { Address, ChainKey, Instant, Text, TokenAmount } from './ids.ts'
import { LimitView } from './limits.ts'

const Readiness = Schema.Literals(['ready', 'blocked', 'not_verified'])
const Short = Schema.String.check(Schema.isMaxLength(64))

/**
 * The part of `wallet_status` goblin's first-class profile reads (goblin's `WalletStatus`, ADR 0043): readiness, each
 * token's balance, what its limit has left and can spend now, when the period ends and when the grant expires. Keep it
 * exactly this shape; extra fields live beside it in `WalletStatusResult`.
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

/** `wallet_status` structured content: goblin's `WalletStatus` plus what the App shows. */
export const WalletStatusResult = Schema.Struct({
  status: WalletStatus,
  owner: Schema.Struct({ address: Address, upgraded: Schema.Boolean }),
  agent: Schema.Struct({ address: Address }),
  balances: Schema.Array(ChainBalance),
  limits: Schema.Array(LimitView),
  checkedAt: Instant,
})
export type WalletStatusResult = typeof WalletStatusResult.Type
