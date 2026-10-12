/**
 * Tempo: the machine-payments rail (MPP `tempo` charge) and plain USDC.e transfers. The agent signs Tempo type-118
 * transactions through `TempoSigner`; `mppx` builds the transaction and the Payment credential around that signer.
 * Before anything is signed, every call in the transaction is checked against the approved terms: only USDC.e
 * `transfer`/`transferWithMemo` to the approved recipient, within the caller's cap.
 */
import * as Data from 'effect/Data'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { Receipt } from 'mppx'
import { Mppx, tempo } from 'mppx/client'
import {
  createClient,
  decodeFunctionData,
  http,
  parseAbi,
  type Account,
  type Address,
  type Client,
  type Hex,
} from 'viem'
import { toAccount } from 'viem/accounts'
import { prepareTransactionRequest, sendRawTransactionSync, signTransaction } from 'viem/actions'
import { tempo as tempoChain } from 'viem/chains'
import { formatUnits, parseUnits } from '../amounts/index.ts'
import { toAddress, toHex } from '../balances/hex.ts'
import { TEMPO } from '../chains/index.ts'
import type { AgentSigner, Payment } from '../contract/index.ts'

export const TEMPO_CHAIN_ID = 4217
const USDC_E = TEMPO.usdc.address
const DECIMALS = TEMPO.usdc.decimals

/** One Tempo call as the signer takes it. */
export interface TempoCallJson {
  readonly to: string
  readonly value: string
  readonly data: string
}

/**
 * A Tempo type-118 transaction in the snake_case JSON Privy's `eth_signTransaction` takes. Quantities are 0x-hex
 * strings. `fee_payer: true` marks a sponsored transaction (the server pays the fee and co-signs); then no `fee_token`.
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
  readonly fee_payer?: boolean
}

/** The agent's signer plus Tempo transaction signing. Resolves with the signed, serialized transaction. */
export interface TempoAgent extends AgentSigner {
  signTempoTransaction(input: { operationKey: string; transaction: TempoTransactionJson }): Promise<string>
}

/** True when the signer can also sign Tempo transactions. */
export const isTempoAgent = (signer: AgentSigner): signer is TempoAgent =>
  'signTempoTransaction' in signer && typeof signer.signTempoTransaction === 'function'

export type TempoFailure = 'bad_challenge' | 'terms_changed' | 'above_cap' | 'unsafe_call' | 'sign_failed'

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

/** viem's Tempo transaction request as the signer's JSON. */
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
  ...(tx.feePayer === true ? { fee_payer: true } : tx.feeToken === undefined ? {} : { fee_token: tx.feeToken }),
})

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
      return toHex(
        await agent.signTempoTransaction({ operationKey: `${operationKey}:tempo`, transaction: toTransactionJson(tx) }),
      )
    },
  })

export type FetchFn = typeof fetch

/** A viem client for Tempo over `fetch`; the RPC URL and fetch are injectable. */
export const tempoClient = (rpcUrl: string = TEMPO.rpcUrl, fetchFn?: typeof fetch): Client =>
  createClient({
    chain: tempoChain,
    transport: http(rpcUrl, fetchFn === undefined ? {} : { fetchFn }),
  })

export interface TempoPaidRequest {
  readonly method: 'GET' | 'POST'
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
}

const initOf = (request: TempoPaidRequest): RequestInit => ({
  method: request.method,
  headers: { ...request.headers },
  redirect: 'manual',
  ...(request.body === undefined ? {} : { body: request.body }),
})

export interface MppQuote {
  readonly terms: TempoTerms
  readonly amountUsd: string
  readonly expiresAt: string | undefined
}

export type MppProbe =
  | { readonly kind: 'quote'; readonly quote: MppQuote }
  | { readonly kind: 'free'; readonly response: Response }
  | { readonly kind: 'unsupported'; readonly status: number }

const ChargeRequest = Schema.Struct({
  amount: Schema.String.check(Schema.isPattern(/^\d{1,30}$/u)),
  currency: Schema.String,
  recipient: Schema.optional(Schema.String),
  methodDetails: Schema.optional(Schema.Struct({ chainId: Schema.optional(Schema.Number) })),
})
const decodeChargeRequest = Schema.decodeUnknownOption(ChargeRequest)

interface Challenge {
  readonly expires?: string | undefined
  readonly request: unknown
}

const quoteOf = (challenge: Challenge): MppQuote | undefined => {
  const request = Option.getOrUndefined(decodeChargeRequest(challenge.request))
  if (request === undefined) return undefined
  if (request.currency.toLowerCase() !== USDC_E.toLowerCase() || request.recipient === undefined) return undefined
  if (request.methodDetails?.chainId !== undefined && request.methodDetails.chainId !== TEMPO_CHAIN_ID) return undefined
  return {
    terms: { network: TEMPO.caip2, asset: USDC_E, recipient: request.recipient, amount: request.amount },
    amountUsd: formatUnits(BigInt(request.amount), DECIMALS),
    expiresAt: challenge.expires,
  }
}

const probeClient = () => Mppx.create({ polyfill: false, methods: [tempo.charge()] })

/** Sends the request unpaid; a Tempo USDC.e `charge` challenge becomes a quote. */
export const probeMpp = async (request: TempoPaidRequest, fetchFn: FetchFn = fetch): Promise<MppProbe> => {
  const response = await fetchFn(request.url, initOf(request))
  if (response.status !== 402) return { kind: 'free', response }
  try {
    const payment = await probeClient().preparePayment(response, { request: initOf(request) })
    const quote = quoteOf(payment.challenge)
    return quote === undefined ? { kind: 'unsupported', status: 402 } : { kind: 'quote', quote }
  } catch {
    // expected: a 402 without a readable Tempo charge challenge is "unsupported", not an error.
    return { kind: 'unsupported', status: 402 }
  }
}

export interface PayMppInput {
  readonly request: TempoPaidRequest
  readonly terms: TempoTerms
  readonly maxUsd: string
  readonly agent: TempoAgent
  readonly operationKey: string
  readonly fetchFn?: FetchFn
  /** The Tempo viem client; tests pass one over a fake node. */
  readonly client?: Client
  readonly now?: () => Date
}

export type MppOutcome = 'settled' | 'unsettled' | 'unknown'

export interface MppPaid {
  readonly outcome: MppOutcome
  readonly payment: Payment | undefined
  readonly response: Response
}

const checkChallenge = (challenge: Challenge, input: PayMppInput): void => {
  const quote = quoteOf(challenge)
  if (quote === undefined) throw new TempoError('bad_challenge', 'the challenge is not a USDC.e charge on Tempo')
  const { terms } = quote
  if (
    terms.recipient.toLowerCase() !== input.terms.recipient.toLowerCase() ||
    BigInt(terms.amount) > BigInt(input.terms.amount)
  )
    throw new TempoError('terms_changed', 'the price or recipient changed since the quote')
  if (BigInt(terms.amount) > parseUnits(input.maxUsd, DECIMALS))
    throw new TempoError('above_cap', 'the price is above max_usd')
}

/** The Payment-Receipt header as the contract's Payment. */
export const paymentOf = (response: Response, now: Date): Payment | undefined => {
  const header = response.headers.get('payment-receipt')
  if (header === null) return undefined
  try {
    const { reference } = Receipt.deserialize(header)
    const txHash = /^0x[0-9a-fA-F]{64}$/u.test(reference) ? toHex(reference) : undefined
    return {
      rail: 'mpp',
      ...(txHash === undefined ? {} : { txHash, explorerUrl: `${TEMPO.explorerUrl}/tx/${txHash}` }),
      reference: reference.slice(0, 512),
      settledAt: now.toISOString(),
    }
  } catch {
    // expected: an unreadable receipt leaves the payment unproven; the caller treats the outcome as unknown.
    return undefined
  }
}

/**
 * Pays an MPP `tempo` charge: reads the live challenge, checks it against the approved terms and cap, has mppx build
 * the sponsored pull transaction (signed through the TempoAgent), and retries with the credential. A failure after the
 * credential is sent is `unknown`: the server may have broadcast it, so it is never retried blind.
 */
export const payMpp = async (input: PayMppInput): Promise<MppPaid> => {
  const fetchFn = input.fetchFn ?? fetch
  const now = input.now ?? (() => new Date())
  const unpaid = await fetchFn(input.request.url, initOf(input.request))
  if (unpaid.status !== 402) return { outcome: 'unsettled', payment: undefined, response: unpaid }
  const allow = { recipient: input.terms.recipient, maxAtomic: parseUnits(input.maxUsd, DECIMALS) }
  const account = tempoAccount(input.agent, input.operationKey, allow)
  const client = input.client ?? tempoClient()
  const mppx = Mppx.create({
    polyfill: false,
    fetch: fetchFn,
    methods: [
      tempo.charge({
        account,
        getClient: () => client,
        expectedChainId: TEMPO_CHAIN_ID,
        allowedChainIds: [TEMPO_CHAIN_ID],
        expectedRecipients: [toAddress(input.terms.recipient)],
        mode: 'pull',
      }),
    ],
  })
  const init = initOf(input.request)
  const payment = await mppx.preparePayment(unpaid, { request: init })
  checkChallenge(payment.challenge, input)
  const credential = await payment.createCredential()
  let response: Response
  try {
    response = await fetchFn(input.request.url, payment.setCredential(init, credential))
  } catch {
    // expected: the credential may have reached the server; the caller records the operation as uncertain.
    return { outcome: 'unknown', payment: undefined, response: new Response(null, { status: 599 }) }
  }
  const paid = paymentOf(response, now())
  if (paid !== undefined) return { outcome: 'settled', payment: paid, response }
  return { outcome: response.status === 402 ? 'unsettled' : 'unknown', payment: undefined, response }
}

export interface TempoTransferInput {
  readonly agent: TempoAgent
  readonly to: string
  /** Atomic USDC.e units. */
  readonly amount: bigint
  readonly operationKey: string
  readonly client?: Client
  /** Called with the signed bytes before broadcast, so a crash can rebroadcast the same transaction. */
  readonly onSigned?: (signed: { raw: Hex }) => Promise<void>
}

export interface TempoTransferResult {
  readonly txHash: Hex
  readonly status: 'success' | 'reverted'
  readonly explorerUrl: string
}

/** Transfers USDC.e on Tempo from the agent, paying the fee in USDC.e. */
export const transferTempoUsdc = async (input: TempoTransferInput): Promise<TempoTransferResult> => {
  const client = input.client ?? tempoClient()
  const recipient = toAddress(input.to)
  const account = tempoAccount(input.agent, input.operationKey, { recipient, maxAtomic: input.amount })
  const data = encodeTransfer(recipient, input.amount)
  // SAFETY: viem's prepare takes the chain-specific request shape; the Tempo `calls` and `feeToken` form is valid here.
  const prepared = await prepareTransactionRequest(client, {
    account,
    calls: [{ to: USDC_E, data }],
    feeToken: USDC_E,
    nonceKey: 'expiring',
    validBefore: Math.floor(Date.now() / 1000) + 25,
  } as never)
  // SAFETY: `prepared` is the fully filled Tempo request viem just returned; its type is chain-generic.
  const raw = await signTransaction(client, prepared as never)
  await input.onSigned?.({ raw })
  const receipt = await sendRawTransactionSync(client, { serializedTransaction: raw })
  return {
    txHash: receipt.transactionHash,
    status: receipt.status === 'success' ? 'success' : 'reverted',
    explorerUrl: `${TEMPO.explorerUrl}/tx/${receipt.transactionHash}`,
  }
}

const encodeTransfer = (to: Address, amount: bigint): Hex => {
  const selector = '0xa9059cbb'
  return `${selector}${to.slice(2).toLowerCase().padStart(64, '0')}${amount.toString(16).padStart(64, '0')}`
}
