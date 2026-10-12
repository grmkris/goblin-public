/**
 * The agent's signer over Privy: one server wallet the owner owns, with this service as its policy-bound additional
 * signer (see `@goblin/wallet/policy`). It implements the contract's `AgentSigner` and Tempo's `TempoAgent`. Every
 * call passes the caller's `operationKey` as Privy's idempotency key, so a retry never signs or sends twice, and every
 * call is refused by Privy itself when it falls outside the policy, whatever this service asked for.
 */
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { type ChainKey, chainByKey } from '../chains/index.ts'
import type { AgentSigner, SignedAuthorization, TypedDataJson, UserOperation } from '../contract/signer.ts'
import type { Address, Hex } from '../contract/ids.ts'
import { type PrivyClient, privyError } from '../privy/client.ts'
import { walletRpc } from '../privy/wallets.ts'
import type { TempoAgent, TempoTransactionJson } from '../tempo/index.ts'
import { toPrivyJson } from '../userop/index.ts'

export interface PrivyAgentConfig {
  readonly privy: PrivyClient
  readonly walletId: string
  readonly address: Address
  /** Mainnets when true (`WALLET_LIVE=1`), their testnets otherwise. */
  readonly live: boolean
}

const SIGNATURE = /^0x[0-9a-fA-F]{130}$/u
const WORD = /^0x[0-9a-fA-F]{64}$/u
const TEMPO_SIGNED = /^0x76[0-9a-fA-F]+$/u

const DOMAIN_FIELDS = [
  ['name', 'string'],
  ['version', 'string'],
  ['chainId', 'uint256'],
  ['verifyingContract', 'address'],
  ['salt', 'bytes32'],
] as const

/** The EIP712Domain type for the fields the domain has, in EIP-712's order (what viem derives before it signs). */
export const domainType = (domain: TypedDataJson['domain']): { name: string; type: string }[] =>
  DOMAIN_FIELDS.filter(([name]) => domain[name] !== undefined).map(([name, type]) => ({ name, type }))

const Authorization = Schema.Struct({
  contract: Schema.optional(Schema.String),
  address: Schema.optional(Schema.String),
  chain_id: Schema.Union([Schema.Number, Schema.String]),
  nonce: Schema.Union([Schema.Number, Schema.String]),
  r: Schema.String.check(Schema.isPattern(WORD)),
  s: Schema.String.check(Schema.isPattern(WORD)),
  y_parity: Schema.Union([Schema.Number, Schema.String]),
})
const decodeAuthorization = Schema.decodeUnknownOption(Authorization)

const ROUTE = '/wallets/:id/rpc'

const field = (data: Record<string, unknown>, name: string, pattern: RegExp, code: string): Hex => {
  const value = data[name]
  if (typeof value !== 'string' || !pattern.test(value)) throw privyError(200, code, ROUTE)
  return value
}

export class PrivyAgentSigner implements TempoAgent {
  readonly address: Address
  readonly #config: PrivyAgentConfig

  constructor(config: PrivyAgentConfig) {
    this.#config = config
    this.address = config.address
  }

  /** EIP-712 typed data (viem style, no EIP712Domain type needed) for `chain`; the domain must name that chain. */
  async signTypedData(input: { chain: ChainKey; typedData: TypedDataJson; operationKey: string }): Promise<Hex> {
    const chain = chainByKey(input.chain, this.#config.live)
    const { domain, types, primaryType, message } = input.typedData
    if (Number(domain['chainId']) !== chain.id) throw privyError(0, 'chain_mismatch', ROUTE)
    const data = await this.#rpc(
      {
        method: 'eth_signTypedData_v4',
        params: {
          typed_data: {
            types: { ...types, EIP712Domain: domainType(domain) },
            primary_type: primaryType,
            domain,
            message,
          },
        },
      },
      input.operationKey,
    )
    return field(data, 'signature', SIGNATURE, 'invalid_signature_response')
  }

  /** An EIP-7702 authorization from the agent wallet (the policy allows only the MetaMask DeleGator). */
  async signAuthorization(input: {
    chain: ChainKey
    contract: Address
    nonce: number
    operationKey: string
  }): Promise<SignedAuthorization> {
    const chain = chainByKey(input.chain, this.#config.live)
    if (!Number.isSafeInteger(input.nonce) || input.nonce < 0) throw privyError(0, 'invalid_nonce', ROUTE)
    const data = await this.#rpc(
      {
        method: 'eth_sign7702Authorization',
        params: { contract: input.contract, chain_id: chain.id, nonce: input.nonce },
      },
      input.operationKey,
    )
    const signed = Option.getOrUndefined(decodeAuthorization(data['authorization']))
    if (
      signed === undefined ||
      (signed.contract ?? signed.address ?? '').toLowerCase() !== input.contract.toLowerCase() ||
      Number(signed.chain_id) !== chain.id ||
      Number(signed.nonce) !== input.nonce ||
      ![0, 1].includes(Number(signed.y_parity))
    )
      throw privyError(200, 'invalid_authorization_response', ROUTE)
    return {
      address: input.contract,
      chainId: chain.id,
      nonce: input.nonce,
      r: signed.r,
      s: signed.s,
      yParity: Number(signed.y_parity),
    }
  }

  /**
   * Signs (never sends) a UserOperation from the agent's 7702-upgraded address: Privy signs the DeleGator's EIP-712
   * digest of it, and its policy checks each call of the batch.
   */
  async signUserOperation(input: { chain: ChainKey; userOp: UserOperation; operationKey: string }): Promise<Hex> {
    const chain = chainByKey(input.chain, this.#config.live)
    const data = await this.#rpc(
      {
        method: 'eth_signUserOperation',
        params: {
          contract: chain.delegation.delegator,
          chain_id: `0x${chain.id.toString(16)}`,
          user_operation: toPrivyJson(input.userOp),
        },
      },
      input.operationKey,
    )
    return field(data, 'signature', SIGNATURE, 'invalid_signature_response')
  }

  /** Signs (never sends) a Tempo type-118 transaction; resolves with the signed serialized `0x76…` bytes. */
  async signTempoTransaction(input: { operationKey: string; transaction: TempoTransactionJson }): Promise<Hex> {
    const tempo = chainByKey('tempo', this.#config.live)
    if (input.transaction.type !== 118 || input.transaction.chain_id !== tempo.id)
      throw privyError(0, 'chain_mismatch', ROUTE)
    const data = await this.#rpc(
      { method: 'eth_signTransaction', params: { transaction: input.transaction } },
      input.operationKey,
    )
    return field(data, 'signed_transaction', TEMPO_SIGNED, 'invalid_tempo_response')
  }

  #rpc(body: Record<string, unknown>, operationKey: string): Promise<Record<string, unknown>> {
    return walletRpc(this.#config.privy, this.#config.walletId, body, operationKey)
  }
}

/** The agent signer as the contract names it, for code that needs no Tempo. */
export const agentSigner = (config: PrivyAgentConfig): AgentSigner => new PrivyAgentSigner(config)
