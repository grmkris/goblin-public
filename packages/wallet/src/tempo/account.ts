/**
 * The agent's side of a Tempo transaction: the signer's JSON, the guards every transaction passes before it is signed
 * (only USDC.e `transfer`/`transferWithMemo` to the approved recipient within the cap, a bounded fee) and the viem
 * account that routes signing to the `TempoAgent`. A sponsored transaction (the service pays the fee) is signed in
 * Tempo's sponsored form; anything else pays its own fee in USDC.e.
 */
import * as Data from 'effect/Data'
import { createClient, decodeFunctionData, http, parseAbi, type Account, type Client, type Hex } from 'viem'
import { toAccount } from 'viem/accounts'
import { tempo as tempoChain } from 'viem/chains'
import { Transaction } from 'viem/tempo'
import { toAddress, toHex } from '../balances/hex.ts'
import { TEMPO } from '../chains/index.ts'
import type { AgentSigner } from '../contract/index.ts'

export const TEMPO_CHAIN_ID = 4217
/** Tempo's bridged USDC (USDC.e), the token every agent payment on Tempo moves. */
export const USDC_E = TEMPO.usdc.address

/** One Tempo call as the signer takes it. */
export interface TempoCallJson {
  readonly to: string
  readonly value: string
  readonly data: string
}

/**
 * A Tempo type-118 transaction in the snake_case JSON Privy's `eth_signTransaction` takes. Quantities are 0x-hex
 * strings. A sponsored transaction (the server pays the fee and co-signs) carries `fee_payer_signature` and no
 * `fee_token`; Privy has no `fee_payer` flag (it answers `invalid_data`).
 */
export interface TempoTransactionJson {
  readonly type: 118
  readonly chain_id: number
  readonly nonce: string
  readonly nonce_key: string
  readonly gas_limit: string
  readonly max_fee_per_gas: string
  readonly max_priority_fee_per_gas: string
  readonly calls: readonly TempoCallJson[]
  readonly valid_before?: string
  readonly valid_after?: string
  readonly fee_token?: string
  readonly fee_payer_signature?: { readonly r: string; readonly s: string; readonly y_parity: 0 | 1 }
}

/** The agent's signer plus Tempo transaction signing. Resolves with the signed, serialized transaction. */
export interface TempoAgent extends AgentSigner {
  signTempoTransaction(input: { operationKey: string; transaction: TempoTransactionJson }): Promise<string>
}

/** True when the signer can also sign Tempo transactions. */
export const isTempoAgent = (signer: AgentSigner): signer is TempoAgent =>
  'signTempoTransaction' in signer && typeof signer.signTempoTransaction === 'function'

export type TempoFailure =
  | 'bad_challenge'
  | 'challenge_expired'
  | 'terms_changed'
  | 'above_cap'
  | 'unsafe_call'
  | 'sign_failed'
  | 'fee_ceiling'

export class TempoError extends Data.TaggedError('TempoError')<{
  readonly code: TempoFailure
  readonly message: string
}> {
  constructor(code: TempoFailure, message: string) {
    super({ code, message })
  }
}

export interface TempoTerms {
  /** CAIP-2, "eip155:4217". */
  readonly network: string
  readonly asset: string
  readonly recipient: string
  /** Atomic USDC.e units, a decimal string. */
  readonly amount: string
}

const TOKEN_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferWithMemo(address to, uint256 amount, bytes32 memo)',
])

interface Spend {
  readonly to: string
  readonly amount: bigint
}

/** Decodes a call to USDC.e `transfer` or `transferWithMemo`; anything else is unsafe. */
export const spendOf = (call: { to?: string | undefined; data?: string | undefined }): Spend => {
  if (call.to?.toLowerCase() !== USDC_E.toLowerCase() || call.data === undefined)
    throw new TempoError('unsafe_call', 'a call targets something other than USDC.e')
  const decoded = decodeFunctionData({ abi: TOKEN_ABI, data: toHex(call.data) })
  const [to, amount] = decoded.args
  return { to, amount }
}

/** Refuses a transaction whose calls spend anything but the approved recipient's amount within the cap. */
export const assertCalls = (
  calls: readonly { to?: string | undefined; data?: string | undefined }[],
  allow: { readonly recipient: string; readonly maxAtomic: bigint },
): void => {
  if (calls.length === 0) throw new TempoError('unsafe_call', 'the transaction has no calls')
  let total = 0n
  for (const call of calls) {
    const spend = spendOf(call)
    if (spend.to.toLowerCase() !== allow.recipient.toLowerCase())
      throw new TempoError('unsafe_call', 'a call pays someone other than the approved recipient')
    total += spend.amount
  }
  if (total > allow.maxAtomic) throw new TempoError('above_cap', 'the transaction spends more than approved')
}

const hex = (value: bigint | number | undefined): string => `0x${(value ?? 0).toString(16)}`

/** Tempo prices gas in 18-decimal dollars and TIP-20 tokens have 6 decimals, so a fee in token units is gas × price / 10^12. */
const FEE_SCALE = 10n ** 12n

/**
 * The most fee one agent transaction may pay on Tempo, in USDC.e base units ($0.05; a transfer costs well under a cent).
 * The fee is paid in USDC.e from the agent's balance and the ledger does not reserve it yet, so this bounds what one
 * signature can burn.
 */
export const TEMPO_FEE_CEILING = 50_000n

/** Refuses a transaction whose worst-case fee (gas limit × max fee per gas) is above the ceiling, before it is signed. */
export const assertFee = (
  tx: { readonly gas?: bigint | undefined; readonly maxFeePerGas?: bigint | undefined },
  ceiling: bigint = TEMPO_FEE_CEILING,
): void => {
  const fee = ((tx.gas ?? 0n) * (tx.maxFeePerGas ?? 0n) + FEE_SCALE - 1n) / FEE_SCALE
  if (fee > ceiling)
    throw new TempoError(
      'fee_ceiling',
      `the network fee (up to ${fee} USDC.e base units) is above the wallet's ceiling`,
    )
}

interface ViemTempoTx {
  readonly calls?: readonly { to?: string | undefined; data?: string | undefined; value?: bigint | undefined }[]
  readonly chainId?: number
  readonly nonce?: number
  readonly nonceKey?: bigint | 'expiring'
  readonly gas?: bigint
  readonly maxFeePerGas?: bigint
  readonly maxPriorityFeePerGas?: bigint
  readonly validBefore?: number
  readonly validAfter?: number
  readonly feeToken?: string
  readonly feePayer?: unknown
}

const EXPIRING_NONCE_KEY = 2n ** 256n - 1n

/**
 * Privy signs a sponsored transaction's sender payload (Tempo's `0x00` fee-payer marker, no fee token) when the request
 * carries any `fee_payer_signature`. This one is a well-formed signature by a throwaway key over a fixed hash: it
 * authorizes nothing, and `sponsored` replaces it with the marker before the bytes leave the wallet, so the service's
 * own fee payer signs in its place.
 */
const FEE_PAYER_PLACEHOLDER = {
  r: '0x441c17f7654bd38e40c29af2673ed7e46802bcd5646bd80dfda529e9966bfeec',
  s: '0x3bdcd1b1b05725831cfa714da2a01ae47d1768d76d61020d9a0dd18ca0a5e663',
  y_parity: 1,
} as const

/** viem's Tempo transaction request as the signer's JSON. Without a sponsor the agent pays the fee in USDC.e. */
export const toTransactionJson = (tx: ViemTempoTx): TempoTransactionJson => ({
  type: 118,
  chain_id: tx.chainId ?? TEMPO_CHAIN_ID,
  nonce: hex(tx.nonce),
  nonce_key: hex(tx.nonceKey === 'expiring' || tx.nonceKey === undefined ? EXPIRING_NONCE_KEY : tx.nonceKey),
  gas_limit: hex(tx.gas),
  max_fee_per_gas: hex(tx.maxFeePerGas),
  max_priority_fee_per_gas: hex(tx.maxPriorityFeePerGas),
  calls: (tx.calls ?? []).map((call) => ({
    to: call.to ?? '0x',
    value: hex(call.value ?? 0n),
    data: call.data ?? '0x',
  })),
  ...(tx.validBefore === undefined ? {} : { valid_before: hex(tx.validBefore) }),
  ...(tx.validAfter === undefined ? {} : { valid_after: hex(tx.validAfter) }),
  ...(tx.feePayer === true ? { fee_payer_signature: FEE_PAYER_PLACEHOLDER } : { fee_token: tx.feeToken ?? USDC_E }),
})

const isTempoBytes = (raw: Hex): raw is `0x76${string}` => raw.startsWith('0x76')

/**
 * The sponsored envelope the service co-signs: the signer's bytes with the placeholder fee-payer signature replaced by
 * Tempo's `0x00` marker. Refused unless the sender it recovers is the agent, so a signature over any other payload (the
 * unsponsored form, another key) never leaves the wallet.
 */
const sponsored = async (signed: Hex, agent: string): Promise<Hex> => {
  if (!isTempoBytes(signed)) throw new TempoError('sign_failed', 'the signer did not return a Tempo transaction')
  const envelope = await Transaction.serialize({ ...Transaction.deserialize(signed), feePayerSignature: null })
  const sender = isTempoBytes(envelope) ? Transaction.deserialize(envelope).from : undefined
  if (sender?.toLowerCase() !== agent.toLowerCase())
    throw new TempoError('sign_failed', 'the sponsored transaction is not signed by the agent')
  return envelope
}

/** A viem account whose `signTransaction` goes to the TempoAgent, after checking the calls against the approval. */
export const tempoAccount = (
  agent: TempoAgent,
  operationKey: string,
  allow: { readonly recipient: string; readonly maxAtomic: bigint },
): Account =>
  toAccount({
    address: toAddress(agent.address),
    signMessage: () => Promise.reject(new TempoError('sign_failed', 'message signing is not used on Tempo')),
    signTypedData: () => Promise.reject(new TempoError('sign_failed', 'typed data is not used on Tempo')),
    // SAFETY: viem types the transaction by chain; the Tempo shape is the only one this account is given.
    signTransaction: async (transaction: unknown) => {
      // SAFETY: mppx and viem hand a Tempo request here; assertCalls rejects anything that is not a USDC.e spend.
      const tx = transaction as ViemTempoTx
      assertCalls(tx.calls ?? [], allow)
      assertFee(tx)
      const signed = toHex(
        await agent.signTempoTransaction({ operationKey: `${operationKey}:tempo`, transaction: toTransactionJson(tx) }),
      )
      return tx.feePayer === true ? sponsored(signed, agent.address) : signed
    },
  })

export type FetchFn = typeof fetch

/** A viem client for Tempo over `fetch`; the RPC URL and fetch are injectable. */
export const tempoClient = (rpcUrl: string = TEMPO.rpcUrl, fetchFn?: typeof fetch): Client =>
  createClient({
    chain: tempoChain,
    transport: http(rpcUrl, fetchFn === undefined ? {} : { fetchFn }),
  })
