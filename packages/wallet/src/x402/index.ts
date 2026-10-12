/**
 * x402 v2 on Base: the agent pays an HTTP 402 with a plain EIP-3009 `exact` USDC authorization. We use Coinbase's
 * `@x402/core` + `@x402/evm` for the payload and header encoding, behind three checks of our own: only the plain Base
 * USDC offer is eligible (not Circle Gateway, not Solana), nothing above the caller's cap is signed, and the payment
 * must match the terms the owner approved.
 */
import * as Data from 'effect/Data'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { ExactEvmScheme } from '@x402/evm/exact/client'
import { x402Client, x402HTTPClient } from '@x402/fetch'
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/fetch'
import { formatUnits, parseUnits } from '../amounts/index.ts'
import { toAddress, toHex } from '../balances/hex.ts'
import { BASE } from '../chains/index.ts'
import type { AgentSigner, Payment } from '../contract/index.ts'

/** Base mainnet in CAIP-2 form; a test pins it to the chain table. */
export const X402_NETWORK = 'eip155:8453'

const USDC_DOMAIN = BASE.usdc.eip3009 ?? { name: 'USD Coin', version: '2' }

export type X402Failure = 'no_offer' | 'above_cap' | 'terms_changed' | 'bad_challenge' | 'refused' | 'sign_failed'

export class X402Error extends Data.TaggedError('X402Error')<{
  readonly code: X402Failure
  readonly message: string
}> {
  constructor(code: X402Failure, message: string) {
    super({ code, message })
  }
}

/** The HTTP request a payment buys. The same request is sent unpaid (the probe) and paid. */
export interface PaidRequest {
  readonly method: 'GET' | 'POST'
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
}

/** What the owner approves: the exact recipient, asset and amount of one Base USDC authorization. */
export interface X402Terms {
  readonly network: string
  readonly asset: string
  readonly recipient: string
  /** Atomic USDC units (6 decimals), a decimal string. */
  readonly amount: string
}

export interface X402Quote {
  readonly terms: X402Terms
  readonly amountUsd: string
  readonly offer: PaymentRequirements
  readonly paymentRequired: PaymentRequired
}

export type X402Probe =
  | { readonly kind: 'quote'; readonly quote: X402Quote }
  | { readonly kind: 'free'; readonly response: Response }
  | { readonly kind: 'unsupported'; readonly status: number }

type FetchFn = (input: string, init: RequestInit) => Promise<Response>

const isExtra = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** Only the plain USDC `exact` offer on Base: EIP-3009, the token's own EIP-712 domain, no Circle Gateway wrapper. */
export const isPlainBaseOffer = (offer: PaymentRequirements): boolean => {
  const extra = isExtra(offer.extra) ? offer.extra : {}
  return (
    offer.scheme === 'exact' &&
    offer.network === X402_NETWORK &&
    offer.asset.toLowerCase() === BASE.usdc.address.toLowerCase() &&
    extra['name'] === USDC_DOMAIN.name &&
    extra['version'] === USDC_DOMAIN.version &&
    extra['verifyingContract'] === undefined &&
    (extra['assetTransferMethod'] === undefined || extra['assetTransferMethod'] === 'eip3009')
  )
}

/** The offer to pay: the explicit EIP-3009 entry when the server marks one, else the first plain Base USDC entry. */
export const selectBaseOffer = (paymentRequired: PaymentRequired): PaymentRequirements | undefined => {
  const plain = paymentRequired.accepts.filter(isPlainBaseOffer)
  return plain.find((offer) => isExtra(offer.extra) && offer.extra['assetTransferMethod'] === 'eip3009') ?? plain[0]
}

const headerReader = (response: Response) => (name: string) => response.headers.get(name)

const parseChallenge = (response: Response): PaymentRequired | undefined => {
  if (response.headers.get('payment-required') === null) return undefined
  try {
    return new x402HTTPClient(new x402Client()).getPaymentRequiredResponse(headerReader(response))
  } catch {
    // expected: a malformed challenge is reported as "unsupported", not as a crash.
    return undefined
  }
}

const send = (fetchFn: FetchFn, request: PaidRequest, extra: Record<string, string> = {}): Promise<Response> => {
  const init: RequestInit = {
    method: request.method,
    headers: { ...request.headers, ...extra },
    redirect: 'manual',
    ...(request.body === undefined ? {} : { body: request.body }),
  }
  return fetchFn(request.url, init)
}

const quoteOf = (paymentRequired: PaymentRequired, offer: PaymentRequirements): X402Quote => ({
  terms: { network: offer.network, asset: offer.asset, recipient: offer.payTo, amount: offer.amount },
  amountUsd: formatUnits(BigInt(offer.amount), BASE.usdc.decimals),
  offer,
  paymentRequired,
})

/**
 * Sends the request unpaid. A 402 with an eligible Base USDC offer becomes a quote; any other answer is returned for
 * the caller to see (a free response is a final answer, nothing to pay).
 */
export const probeX402 = async (request: PaidRequest, fetchFn: FetchFn = fetch): Promise<X402Probe> => {
  const response = await send(fetchFn, request)
  if (response.status !== 402) return { kind: 'free', response }
  const challenge = parseChallenge(response)
  const offer = challenge === undefined ? undefined : selectBaseOffer(challenge)
  if (challenge === undefined || offer === undefined) return { kind: 'unsupported', status: 402 }
  return { kind: 'quote', quote: quoteOf(challenge, offer) }
}

type SignTypedData = (message: {
  domain: Record<string, unknown>
  types: Record<string, unknown>
  primaryType: string
  message: Record<string, unknown>
}) => Promise<`0x${string}`>

/** JSON form of EIP-712 values: bigints become decimal strings, the shape the AgentSigner takes. */
const jsonSafe = (value: unknown): unknown => {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (isExtra(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]))
  return value
}

type TypeFields = readonly { readonly name: string; readonly type: string }[]

const typesOf = (types: Record<string, unknown>): Record<string, TypeFields> =>
  Object.fromEntries(
    Object.entries(types).map(([name, fields]) => [
      name,
      Array.isArray(fields)
        ? fields.flatMap((field: unknown) =>
            isExtra(field) && typeof field['name'] === 'string' && typeof field['type'] === 'string'
              ? [{ name: field['name'], type: field['type'] }]
              : [],
          )
        : [],
    ]),
  )

/** A `ClientEvmSigner` that signs through the AgentSigner on Base; one stable key per operation. */
export const clientSigner = (
  agent: AgentSigner,
  operationKey: string,
): { address: `0x${string}`; signTypedData: SignTypedData } => ({
  address: toAddress(agent.address),
  signTypedData: async (message) => {
    const signature = await agent.signTypedData({
      chain: 'base',
      operationKey: `${operationKey}:x402`,
      typedData: {
        domain: Object.fromEntries(Object.entries(message.domain).map(([key, value]) => [key, jsonSafe(value)])),
        types: typesOf(message.types),
        primaryType: message.primaryType,
        message: Object.fromEntries(Object.entries(message.message).map(([key, value]) => [key, jsonSafe(value)])),
      },
    })
    return toHex(signature)
  },
})

export interface PayX402Input {
  readonly request: PaidRequest
  readonly terms: X402Terms
  /** The caller's cap in USD (a decimal string); nothing above it is signed. */
  readonly maxUsd: string
  readonly agent: AgentSigner
  readonly operationKey: string
  readonly fetchFn?: FetchFn
  readonly now?: () => Date
}

export type X402Outcome = 'settled' | 'unsettled' | 'unknown'

export interface X402Paid {
  /**
   * `settled`: the server confirmed settlement. `unknown`: the credential left the wallet, so money may have moved
   * whatever the answer (even a 402); reconcile, never retry blind. `unsettled`: no credential was ever sent.
   */
  readonly outcome: X402Outcome
  readonly payment: Payment | undefined
  readonly response: Response
}

const sameTerms = (offer: PaymentRequirements, terms: X402Terms): boolean =>
  offer.network === terms.network &&
  offer.asset.toLowerCase() === terms.asset.toLowerCase() &&
  offer.payTo.toLowerCase() === terms.recipient.toLowerCase() &&
  BigInt(offer.amount) <= BigInt(terms.amount)

const buildClient = (agent: AgentSigner, operationKey: string, maxUsd: string, offer: PaymentRequirements) =>
  new x402Client()
    .register(X402_NETWORK, new ExactEvmScheme(clientSigner(agent, operationKey)))
    .setSpendControls({ maxAmountPerPayment: `$${maxUsd}` })
    .registerPolicy((_version, offers) =>
      offers.filter(
        (candidate) =>
          candidate.payTo === offer.payTo && candidate.amount === offer.amount && isPlainBaseOffer(candidate),
      ),
    )

/** The settlement the server reports in PAYMENT-RESPONSE, as the contract's Payment. */
export const paymentOf = (response: Response, now: Date): Payment | undefined => {
  if (response.headers.get('payment-response') === null) return undefined
  try {
    const settle = new x402HTTPClient(new x402Client()).getPaymentSettleResponse(headerReader(response))
    if (!settle.success) return undefined
    const txHash = settle.transaction ? toHex(settle.transaction) : undefined
    return {
      rail: 'x402',
      ...(txHash === undefined ? {} : { txHash, explorerUrl: `${BASE.explorerUrl}/tx/${txHash}` }),
      reference: JSON.stringify({
        network: settle.network,
        payer: settle.payer,
        transaction: settle.transaction,
      }).slice(0, 512),
      settledAt: now.toISOString(),
    }
  } catch {
    // expected: an unreadable PAYMENT-RESPONSE leaves the payment unproven, which the caller treats as unknown.
    return undefined
  }
}

const checkOffer = (offer: PaymentRequirements | undefined, input: PayX402Input): PaymentRequirements => {
  if (offer === undefined) throw new X402Error('no_offer', 'the service no longer offers a plain Base USDC price')
  if (!sameTerms(offer, input.terms))
    throw new X402Error('terms_changed', 'the price or recipient changed since the quote')
  if (BigInt(offer.amount) > parseUnits(input.maxUsd, BASE.usdc.decimals))
    throw new X402Error('above_cap', 'the price is above max_usd')
  return offer
}

const signPayload = async (
  input: PayX402Input,
  challenge: PaymentRequired,
  offer: PaymentRequirements,
): Promise<PaymentPayload> => {
  const client = buildClient(input.agent, input.operationKey, input.maxUsd, offer)
  try {
    return await new x402HTTPClient(client).createPaymentPayload({ ...challenge, accepts: [offer] })
  } catch (error) {
    throw new X402Error('sign_failed', error instanceof Error ? error.message : 'signing failed')
  }
}

/**
 * Pays the request: re-reads the live challenge, checks it still matches the approved terms and the cap, signs the
 * authorization and retries with PAYMENT-SIGNATURE. A transport failure after signing is `unknown`, never retried.
 */
export const payX402 = async (input: PayX402Input): Promise<X402Paid> => {
  const fetchFn = input.fetchFn ?? fetch
  const now = input.now ?? (() => new Date())
  const unpaid = await send(fetchFn, input.request)
  if (unpaid.status !== 402) return { outcome: 'unsettled', payment: undefined, response: unpaid }
  const challenge = parseChallenge(unpaid)
  if (challenge === undefined) throw new X402Error('bad_challenge', 'the 402 carries no readable x402 challenge')
  const offer = checkOffer(selectBaseOffer(challenge), input)
  const payload = await signPayload(input, challenge, offer)
  const authorization = authorizationOf(payload)
  // What an unknown outcome keeps so it can be checked on chain later; the authorization itself is never resent.
  const evidence: Payment | undefined = authorization === undefined ? undefined : { rail: 'x402', authorization }
  const headers = new x402HTTPClient(new x402Client()).encodePaymentSignatureHeader(payload)
  let response: Response
  try {
    response = await send(fetchFn, input.request, headers)
  } catch {
    // expected: the paid request may have reached the server; the caller records the operation as uncertain.
    return { outcome: 'unknown', payment: evidence, response: new Response(null, { status: 599 }) }
  }
  const payment = paymentOf(response, now())
  if (payment !== undefined)
    return {
      outcome: 'settled',
      payment: authorization === undefined ? payment : { ...payment, authorization },
      response,
    }
  // The authorization is out: a 402 or any answer without a receipt cannot revoke it, so it is never `unsettled`.
  return { outcome: 'unknown', payment: evidence, response }
}

const Eip3009 = Schema.Struct({
  authorization: Schema.Struct({
    from: Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{40}$/u)),
    nonce: Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{64}$/u)),
    validBefore: Schema.Union([Schema.String, Schema.Number]),
  }),
})
const decodeEip3009 = Schema.decodeUnknownOption(Eip3009)

/** The signed EIP-3009 authorization in an x402 payload (Base USDC's `exact` scheme), or undefined for another kind. */
export const authorizationOf = (payload: PaymentPayload): NonNullable<Payment['authorization']> | undefined => {
  const decoded = decodeEip3009(payload.payload)
  if (Option.isNone(decoded)) return undefined
  const { from, nonce, validBefore } = decoded.value.authorization
  const seconds = String(validBefore)
  return /^\d{1,20}$/u.test(seconds) ? { from, nonce, validBefore: seconds } : undefined
}
