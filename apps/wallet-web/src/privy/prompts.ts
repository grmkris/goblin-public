import type { TypedDataJson } from '@goblin/wallet/contract'
import type { ReviewedAllowance, ReviewedSubscription } from '@goblin/wallet/delegation'
import type { SignTypedDataParams } from '@privy-io/react-auth'

/** What Privy's screen says for one signature: what it allows, for whom and its limit, never the raw typed data. */
export interface WalletPrompt {
  readonly title: string
  readonly description: string
  readonly buttonText: string
}

const day = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })

export const allowancePrompt = (chainName: string, description: ReviewedAllowance['description']): WalletPrompt => ({
  title: `Let your agent spend up to $${description.perHour} an hour`,
  description:
    `Your agent wallet may move up to ${description.perHour} ${description.token} an hour from this wallet on ` +
    `${chainName}, only to itself, until ${day(description.expiresAt)}. The chain enforces the limit; nothing moves ` +
    'now, and you can revoke it any time.',
  buttonText: 'Allow',
})

/** "$0.02": a USDC amount in base units, rounded up to the cent because it is an upper bound. */
const atMostUsd = (units: bigint): string => {
  const cents = (units + 9_999n) / 10_000n
  return `$${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`
}

/** A merchant's subscription (ADR 0054): so much every so many days, only to its collector, until the last period. */
export const subscriptionPrompt = (
  chainName: string,
  merchant: string,
  description: ReviewedSubscription['description'],
): WalletPrompt => ({
  title: `Subscribe to ${merchant} Pro: $${description.amountUsd} every ${description.periodDays} days`,
  description:
    `${merchant} may take up to ${description.amountUsd} ${description.token} every ${description.periodDays} days ` +
    `from this wallet on ${chainName}, only to its own address, until ${day(description.expiresAt)}. The chain ` +
    'enforces every term, and you can cancel any time.',
  buttonText: 'Sign',
})

/** The owner's cancellation: one operation from their account, its gas paid in USDC from it. */
export const cancelPrompt = (merchant: string, maxFee: bigint): WalletPrompt => ({
  title: `Cancel ${merchant} Pro`,
  description: `Turns the subscription off on-chain. Gas of at most ${atMostUsd(maxFee)} is paid in USDC from your account.`,
  buttonText: 'Cancel subscription',
})

/** The second signature of the upgrade: the UserOperation that carries it, its gas paid in USDC from the account. */
export const upgradePrompt = (maxFee: bigint): WalletPrompt => ({
  title: 'Upgrade your account',
  description: `One-time. Gas of at most ${atMostUsd(maxFee)} is paid in USDC from your account.`,
  buttonText: 'Upgrade',
})

const DOMAIN_FIELDS = [
  ['name', 'string'],
  ['version', 'string'],
  ['chainId', 'uint256'],
  ['verifyingContract', 'address'],
  ['salt', 'bytes32'],
] as const

/**
 * Typed data exactly as a JSON-RPC wallet takes it (`eth_signTypedData_v4`): the EIP712Domain type derived from the
 * domain's fields, as viem derives it before signing. Without it a wallet hashes an empty domain and signs something
 * else.
 */
export const walletTypedData = (typedData: TypedDataJson): SignTypedDataParams => ({
  domain: typedData.domain,
  types: {
    ...Object.fromEntries(Object.entries(typedData.types).map(([name, fields]) => [name, [...fields]])),
    EIP712Domain: DOMAIN_FIELDS.filter(([name]) => typedData.domain[name] !== undefined).map(([name, type]) => ({
      name,
      type,
    })),
  },
  primaryType: typedData.primaryType,
  message: typedData.message,
})
