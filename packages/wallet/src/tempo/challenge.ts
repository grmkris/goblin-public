/**
 * MPP `tempo` charge challenges: reading one into terms, and the Payment-Receipt that settles one.
 */
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { Receipt } from 'mppx'
import { formatUnits } from '../amounts/index.ts'
import { toHex } from '../balances/hex.ts'
import { TEMPO } from '../chains/index.ts'
import type { Payment } from '../contract/index.ts'
import { TEMPO_CHAIN_ID, type TempoTerms, USDC_E } from './account.ts'

const DECIMALS = TEMPO.usdc.decimals

export interface MppQuote {
  readonly terms: TempoTerms
  readonly amountUsd: string
  readonly expiresAt: string | undefined
}

const ChargeRequest = Schema.Struct({
  amount: Schema.String.check(Schema.isPattern(/^\d{1,30}$/u)),
  currency: Schema.String,
  recipient: Schema.optional(Schema.String),
  methodDetails: Schema.optional(Schema.Struct({ chainId: Schema.optional(Schema.Number) })),
})
const decodeChargeRequest = Schema.decodeUnknownOption(ChargeRequest)

/** The part of an mppx challenge a quote reads. */
export interface ChargeChallenge {
  readonly expires?: string | undefined
  readonly request: unknown
}

/** A USDC.e charge on Tempo mainnet as terms; anything else (another token or chain, no recipient) is undefined. */
export const quoteOf = (challenge: ChargeChallenge): MppQuote | undefined => {
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

const TX_HASH = /^0x[0-9a-fA-F]{64}$/u

/** A Payment-Receipt header value's method and reference, or undefined when it cannot be read. */
const readReceipt = (header: string): { method: string; reference: string } | undefined => {
  try {
    const { method, reference } = Receipt.deserialize(header)
    return { method, reference }
  } catch {
    // expected: an unreadable receipt proves nothing; each caller says what that means for its outcome.
    return undefined
  }
}

const receiptPayment = (header: string, now: Date): Payment | undefined => {
  const read = readReceipt(header)
  if (read === undefined) return undefined
  const txHash = TX_HASH.test(read.reference) ? toHex(read.reference) : undefined
  return {
    rail: 'mpp',
    ...(txHash === undefined ? {} : { txHash, explorerUrl: `${TEMPO.explorerUrl}/tx/${txHash}` }),
    reference: read.reference.slice(0, 512),
    settledAt: now.toISOString(),
  }
}

/** The Payment-Receipt header as the contract's Payment; an unreadable one leaves the payment unproven. */
export const paymentOf = (response: Response, now: Date): Payment | undefined => {
  const header = response.headers.get('payment-receipt')
  return header === null ? undefined : receiptPayment(header, now)
}
