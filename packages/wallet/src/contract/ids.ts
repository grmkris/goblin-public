import * as Schema from 'effect/Schema'

/** A string of 1 to `max` characters. */
export const Text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))

/** A caller-chosen id that makes a paid or signing call idempotent: the same id finds the same operation. */
export const OperationId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{8,128}$/u))
export type OperationId = typeof OperationId.Type

/** An EVM address, checksummed or lower case. */
export const Address = Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{40}$/u))
export type Address = typeof Address.Type

/** A 0x-prefixed hex string. */
export const Hex = Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]*$/u))
export type Hex = typeof Hex.Type

/** The chains the wallet acts on tonight (EVM first; Solana comes later). */
export const ChainKey = Schema.Literals(['base', 'ethereum', 'arbitrum', 'tempo'])
export type ChainKey = typeof ChainKey.Type

/** A USD amount as a plain decimal string ("0.007", "5"); never a float, an exponent or a sign. */
export const UsdAmount = Schema.String.check(Schema.isPattern(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/u))
export type UsdAmount = typeof UsdAmount.Type

/** A token amount in its own decimals, as a plain decimal string. */
export const TokenAmount = Schema.String.check(Schema.isPattern(/^(?:0|[1-9]\d{0,30})(?:\.\d{1,18})?$/u))
export type TokenAmount = typeof TokenAmount.Type

/** An ISO-8601 instant. */
export const Instant = Text(40)
