/**
 * Privy server wallets: the owner-owned agent wallet (owner = the Privy user, this service an additional signer under
 * the agent policy) and its RPC. Ported from Sidequest's `PrivyServer` (`createAgentWallet`, `verifyAgentWallet`,
 * `signTypedData`, `signAuthorization`).
 */
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { Address } from '../contract/ids.ts'
import { type PrivyClient, privyError, privyId } from './client.ts'

const Signer = Schema.Struct({ signer_id: Schema.String, override_policy_ids: Schema.Array(Schema.String) })
const WalletRecord = Schema.Struct({
  id: Schema.String,
  address: Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{40}$/u)),
  chain_type: Schema.Literal('ethereum'),
  owner_id: Schema.NullOr(Schema.String),
  additional_signers: Schema.Array(Signer),
})
const decodeWallet = Schema.decodeUnknownOption(WalletRecord)
const decodeWalletList = Schema.decodeUnknownOption(Schema.Struct({ data: Schema.Array(Schema.Unknown) }))
const decodeQuorum = Schema.decodeUnknownOption(Schema.Struct({ user_ids: Schema.Array(Schema.String) }))

export interface PrivyWallet {
  readonly id: string
  readonly address: Address
  /** The key quorum that owns the wallet (for a user-owned wallet, one holding the user). */
  readonly ownerId: string | null
  readonly signers: readonly { readonly signerId: string; readonly policyIds: readonly string[] }[]
}

const toWallet = (value: unknown, route: string): PrivyWallet => {
  const wallet = Option.getOrUndefined(decodeWallet(value))
  if (wallet === undefined) throw privyError(200, 'invalid_wallet_response', route)
  return {
    id: wallet.id,
    address: wallet.address,
    ownerId: wallet.owner_id,
    signers: wallet.additional_signers.map((signer) => ({
      signerId: signer.signer_id,
      policyIds: signer.override_policy_ids,
    })),
  }
}

export const getWallet = async (client: PrivyClient, walletId: string): Promise<PrivyWallet> =>
  toWallet(await client.request('GET', `/wallets/${privyId(walletId)}`), '/wallets/:id')

/** The user's EVM wallets: their embedded wallet and any server wallet they own. */
export const userWallets = async (client: PrivyClient, userId: string): Promise<PrivyWallet[]> => {
  const route = `/wallets?user_id=${encodeURIComponent(userId)}&chain_type=ethereum&limit=100`
  const list = Option.getOrUndefined(decodeWalletList(await client.request('GET', route)))
  if (list === undefined) throw privyError(200, 'invalid_wallet_list', '/wallets')
  // Wallets of another shape (another chain type, an unexpected answer) are not ours to consider.
  return list.data.filter((value) => Option.isSome(decodeWallet(value))).map((value) => toWallet(value, '/wallets'))
}

export interface AgentAuthority {
  readonly userId: string
  /** The routine key quorum this service signs with. */
  readonly signerId: string
  /** The agent policy the signer is held to. */
  readonly policyId: string
}

/** Exactly our signer, held to exactly the agent policy, and nobody else's. */
const heldByUs = (wallet: PrivyWallet, authority: AgentAuthority): boolean =>
  wallet.signers.length === 1 &&
  wallet.signers[0]?.signerId === authority.signerId &&
  wallet.signers[0].policyIds.length === 1 &&
  wallet.signers[0].policyIds[0] === authority.policyId

/** Refuses a wallet that is not owned by the user alone or not held by our signer under the agent policy. */
export const verifyAgentWallet = async (
  client: PrivyClient,
  wallet: PrivyWallet,
  authority: AgentAuthority,
): Promise<PrivyWallet> => {
  if (wallet.ownerId === null || !heldByUs(wallet, authority))
    throw privyError(200, 'wallet_authority_mismatch', '/wallets/:id')
  const quorum = Option.getOrUndefined(
    decodeQuorum(await client.request('GET', `/key_quorums/${privyId(wallet.ownerId)}`)),
  )
  if (quorum?.user_ids.length !== 1 || quorum.user_ids[0] !== authority.userId)
    throw privyError(200, 'wallet_authority_mismatch', '/key_quorums/:id')
  return wallet
}

/** Privy's idempotency key for the user's agent wallet: one per user, whatever retries. */
export const agentWalletKey = (userId: string): string => `goblin-agent-wallet-${userId.replace(/[^A-Za-z0-9]/gu, '-')}`

/**
 * The owner's agent wallet, created at most once: an existing user-owned wallet already held by our signer under the
 * agent policy is returned as it is; otherwise one is created with the user as owner and our signer as its only
 * additional signer. Either way the authority is verified before it is returned.
 */
export const createAgentWallet = async (client: PrivyClient, authority: AgentAuthority): Promise<PrivyWallet> => {
  privyId(authority.userId)
  privyId(authority.signerId)
  privyId(authority.policyId)
  const existing = (await userWallets(client, authority.userId)).find((wallet) => heldByUs(wallet, authority))
  if (existing !== undefined) return verifyAgentWallet(client, existing, authority)
  const created = toWallet(
    await client.request(
      'POST',
      '/wallets',
      {
        chain_type: 'ethereum',
        owner: { user_id: authority.userId },
        additional_signers: [{ signer_id: authority.signerId, override_policy_ids: [authority.policyId] }],
      },
      { idempotencyKey: agentWalletKey(authority.userId) },
    ),
    '/wallets',
  )
  return verifyAgentWallet(client, created, authority)
}

const RpcAnswer = Schema.Struct({ data: Schema.Record(Schema.String, Schema.Unknown) })
const decodeRpc = Schema.decodeUnknownOption(RpcAnswer)

/** One signed call to the wallet's RPC; resolves with its `data`. */
export const walletRpc = async (
  client: PrivyClient,
  walletId: string,
  body: Record<string, unknown>,
  operationKey: string,
): Promise<Record<string, unknown>> => {
  const answer = await client.request('POST', `/wallets/${privyId(walletId)}/rpc`, body, {
    idempotencyKey: operationKey,
    signed: true,
  })
  const data = Option.getOrUndefined(decodeRpc(answer))?.data
  if (data === undefined) throw privyError(200, 'invalid_rpc_response', '/wallets/:id/rpc')
  return data
}
