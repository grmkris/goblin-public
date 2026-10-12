/**
 * Tempo: the machine-payments rail (MPP `tempo` charge) and plain USDC.e transfers. The agent signs Tempo type-118
 * transactions through `TempoAgent`; `mppx` builds the transaction and the Payment credential around that signer.
 * Before anything is signed, every call in the transaction is checked against the approved terms: only USDC.e
 * `transfer`/`transferWithMemo` to the approved recipient, within the caller's cap (`account.ts`). `challenge.ts` reads
 * challenges and receipts, and signs a challenge a caller fetched itself, without fetching.
 */
import { Mppx, tempo } from 'mppx/client'
import type { Address, Client, Hex } from 'viem'
import { prepareTransactionRequest, sendRawTransactionSync, signTransaction } from 'viem/actions'
import { parseUnits } from '../amounts/index.ts'
import { toAddress } from '../balances/hex.ts'
import { TEMPO } from '../chains/index.ts'
import type { Payment } from '../contract/index.ts'
import {
  type FetchFn,
  TEMPO_CHAIN_ID,
  type TempoAgent,
  TempoError,
  type TempoTerms,
  tempoAccount,
  tempoClient,
  USDC_E,
} from './account.ts'
import { type ChargeChallenge, type MppQuote, paymentOf, quoteOf } from './challenge.ts'

export * from './account.ts'
export * from './challenge.ts'

const DECIMALS = TEMPO.usdc.decimals

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

export type MppProbe =
  | { readonly kind: 'quote'; readonly quote: MppQuote }
  | { readonly kind: 'free'; readonly response: Response }
  | { readonly kind: 'unsupported'; readonly status: number }

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

const checkChallenge = (challenge: ChargeChallenge, input: PayMppInput): void => {
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
  // The signed credential is out: a 402 or any answer without a receipt cannot revoke it, so it is never `unsettled`.
  return { outcome: 'unknown', payment: undefined, response }
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
