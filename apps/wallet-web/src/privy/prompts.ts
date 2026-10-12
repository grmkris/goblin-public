import type { TypedDataJson } from '@goblin/wallet/contract'
import type { ReviewedAllowance } from '@goblin/wallet/delegation'
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
