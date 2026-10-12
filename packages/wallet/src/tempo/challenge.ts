/**
 * MPP `tempo` charge challenges: reading one into terms, the Payment-Receipt that settles one, and signing a challenge a
 * caller fetched itself (`pay_challenge`). There the wallet never fetches: the caller hands over the service's 402
 * `WWW-Authenticate` value, the wallet picks its Tempo USDC.e charge, signs it under the payee and amount frozen in the
 * ledger, and hands back the Payment credential; the caller later reports the service's receipt, which is checked
 * against the chain.
 */
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { Challenge as MppChallenge, Receipt } from 'mppx'
import { Mppx, tempo } from 'mppx/client'
import { keccak256, type Client, type Hex, type Log, parseAbi, parseEventLogs, stringToHex } from 'viem'
import { getTransactionReceipt } from 'viem/actions'
import { formatUnits } from '../amounts/index.ts'
import { toAddress, toHex } from '../balances/hex.ts'
import { TEMPO } from '../chains/index.ts'
import type { Payment } from '../contract/index.ts'
import {
  TEMPO_CHAIN_ID,
  type TempoAgent,
  TempoError,
  type TempoTerms,
  tempoAccount,
  tempoClient,
  USDC_E,
} from './account.ts'

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

/** The challenge `pay_challenge` signs: its id and the Tempo terms it asks for, read before anything is reserved. */
export interface ChallengeQuote extends MppQuote {
  readonly challengeId: string
  readonly expiresAt: string
}

const challengesOf = (header: string): readonly MppChallenge.Challenge[] => {
  try {
    return MppChallenge.deserializeList(header)
  } catch {
    // expected: a value that is not a Payment challenge is refused before anything is reserved.
    throw new TempoError('bad_challenge', 'The challenge is not a readable Payment WWW-Authenticate value.')
  }
}

/**
 * Reads a raw `WWW-Authenticate` value, which may hold several `Payment` entries, and picks its first `method="tempo"`
 * `intent="charge"` entry in USDC.e on Tempo mainnet. Refused when there is none, when it wants its credential in a
 * header other than Authorization, and when it has no expiry or has expired.
 */
export const readChallenge = (header: string, now: Date): ChallengeQuote => {
  const found = challengesOf(header).flatMap((challenge) => {
    const quote = challenge.method === 'tempo' && challenge.intent === 'charge' ? quoteOf(challenge) : undefined
    return quote === undefined ? [] : [{ challenge, quote }]
  })[0]
  if (found === undefined) throw new TempoError('bad_challenge', 'The challenge offers no Tempo USDC.e charge.')
  const { challenge, quote } = found
  if (challenge.header !== undefined && challenge.header.toLowerCase() !== 'authorization')
    throw new TempoError('bad_challenge', 'The challenge wants its credential in a header other than Authorization.')
  if (challenge.expires === undefined || Date.parse(challenge.expires) <= now.getTime())
    throw new TempoError('challenge_expired', 'The challenge has expired or never expires; fetch a new one.')
  return { ...quote, challengeId: challenge.id, expiresAt: challenge.expires }
}

export interface SignChallengeInput {
  /** The raw `WWW-Authenticate` value the challenge was read from. */
  readonly header: string
  /** What the ledger froze: the challenge id, the payee's recipient and the amount in USDC.e base units. */
  readonly challengeId: string
  readonly recipient: string
  readonly amount: bigint
  readonly agent: TempoAgent
  readonly operationKey: string
  readonly client?: Client
  readonly now?: () => Date
}

const PAYMENT_SCHEME = /^Payment\s+(?<token>[A-Za-z0-9_-]+)$/u

/**
 * Signs a frozen challenge without fetching: mppx builds the pull transaction from a 402 carrying the same header, the
 * agent's account refuses any call but USDC.e to the frozen recipient within the frozen amount, and the credential
 * comes back as the token after `Payment ` (the caller sends `Authorization: Payment <credential>`). A challenge whose
 * id, recipient or price changed since it was frozen is refused before anything is signed.
 */
export const signChallenge = async (input: SignChallengeInput): Promise<string> => {
  const current = readChallenge(input.header, (input.now ?? (() => new Date()))())
  if (
    current.challengeId !== input.challengeId ||
    current.terms.recipient.toLowerCase() !== input.recipient.toLowerCase() ||
    BigInt(current.terms.amount) !== input.amount
  )
    throw new TempoError('terms_changed', 'The challenge is not the one this operation froze.')
  const account = tempoAccount(input.agent, input.operationKey, { recipient: input.recipient, maxAtomic: input.amount })
  const client = input.client ?? tempoClient()
  const mppx = Mppx.create({
    polyfill: false,
    methods: [
      tempo.charge({
        account,
        getClient: () => client,
        expectedChainId: TEMPO_CHAIN_ID,
        allowedChainIds: [TEMPO_CHAIN_ID],
        expectedRecipients: [toAddress(input.recipient)],
        mode: 'pull',
      }),
    ],
    orderChallenges: (candidates) => candidates.filter((candidate) => candidate.challenge.id === input.challengeId),
  })
  const unpaid = new Response(null, { status: 402, headers: { 'www-authenticate': input.header } })
  const payment = await mppx.preparePayment(unpaid)
  const token = PAYMENT_SCHEME.exec(await payment.createCredential())?.groups?.['token']
  if (token === undefined) throw new TempoError('sign_failed', 'The credential is not a Payment authorization.')
  return token
}

const TIP20_EVENTS = parseAbi([
  'event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)',
])

export interface ReceiptCheck {
  /** The `Payment-Receipt` header value the caller got from the service. */
  readonly receipt: string
  readonly agent: string
  readonly recipient: string
  /** USDC.e base units. */
  readonly amount: bigint
  readonly challengeId: string
  readonly client?: Client
  readonly now?: () => Date
}

export type ReceiptFinding =
  | { readonly kind: 'paid'; readonly payment: Payment }
  | { readonly kind: 'unknown'; readonly reason: string }
  | { readonly kind: 'mismatch'; readonly reason: string }

/**
 * The USDC.e the agent sent the recipient under this challenge's attribution memo (mppx binds bytes 25..31 of the memo
 * to keccak256 of the challenge id), so a receipt of another call to the same payee never settles this one.
 */
const paidUnder = (logs: readonly Log[], check: ReceiptCheck): bigint => {
  const nonce = keccak256(stringToHex(check.challengeId)).slice(2, 16)
  return parseEventLogs({ abi: TIP20_EVENTS, logs: [...logs], strict: true })
    .filter(
      (log) =>
        log.address.toLowerCase() === USDC_E.toLowerCase() &&
        log.args.from.toLowerCase() === check.agent.toLowerCase() &&
        log.args.to.toLowerCase() === check.recipient.toLowerCase() &&
        log.args.memo.slice(52, 66).toLowerCase() === nonce,
    )
    .reduce((sum, log) => sum + log.args.amount, 0n)
}

const mined = async (client: Client, hash: Hex) => {
  try {
    return await getTransactionReceipt(client, { hash })
  } catch {
    // expected: a transaction the node does not show yet, or an RPC that failed, is unknown, never paid.
    return undefined
  }
}

/**
 * Checks a reported Payment-Receipt against the chain: a Tempo receipt naming a transaction that succeeded and moved
 * exactly the frozen USDC.e amount from the agent to the recipient under this challenge's memo. A transaction the node
 * does not show yet is unknown; anything else is a mismatch.
 */
export const confirmReceipt = async (check: ReceiptCheck): Promise<ReceiptFinding> => {
  const payment = receiptPayment(check.receipt, (check.now ?? (() => new Date()))())
  if (readReceipt(check.receipt)?.method !== 'tempo' || payment?.txHash === undefined)
    return { kind: 'mismatch', reason: 'This is not a Tempo Payment-Receipt that names a transaction.' }
  const receipt = await mined(check.client ?? tempoClient(), toHex(payment.txHash))
  if (receipt === undefined)
    return { kind: 'unknown', reason: 'Tempo does not show that transaction yet; report the receipt again shortly.' }
  if (receipt.status !== 'success')
    return { kind: 'mismatch', reason: 'The receipt names a transaction that reverted.' }
  if (paidUnder(receipt.logs, check) !== check.amount)
    return { kind: 'mismatch', reason: "The receipt's transaction does not pay this challenge from the agent." }
  return { kind: 'paid', payment }
}
