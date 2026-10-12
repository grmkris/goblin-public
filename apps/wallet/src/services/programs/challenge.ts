import { TEMPO } from '@goblin/wallet/chains'
import { type MppPayee, payeeOf, type PayChallengeInput, type Terms, TOOLS } from '@goblin/wallet/contract'
import { type ChallengeQuote, readChallenge, TempoError } from '@goblin/wallet/tempo'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import { failure } from '../errors.ts'
import { Ledger } from '../ledger.ts'
import { Rails } from '../rails.ts'
import { readOperation } from './operation.ts'
import { argsHashOf, runSpend, type SpendPlan } from './spend.ts'

/** A `pay_challenge` call that pays, with every field it needs and the payee its url names. */
interface PayRequest {
  readonly url: string
  readonly method: 'GET' | 'POST'
  readonly challenge: string
  readonly maxUsd: string
  readonly payee: MppPayee
}

const payRequestOf = (input: PayChallengeInput) =>
  Effect.gen(function* () {
    const { url, method, challenge, max_usd: maxUsd } = input
    if (url === undefined || method === undefined || challenge === undefined || maxUsd === undefined)
      return yield* failure(
        'bad_request',
        'To pay, pass url, method, challenge and max_usd with the operation_id.',
        400,
        'To report a receipt, pass the operation_id and receipt only.',
      )
    const payee = payeeOf(url)
    if (payee === undefined)
      return yield* failure('unknown_payee', "This url's origin is not one of the wallet's MPP payees.", 403)
    return { url, method, challenge, maxUsd, payee } satisfies PayRequest
  })

/** The frozen terms of a challenge: a USDC.e charge on Tempo to the payee, for the exact request it buys. */
const termsOf = (request: PayRequest, quote: ChallengeQuote): Terms => ({
  kind: 'paid_fetch',
  chain: 'tempo',
  rail: 'mpp',
  subject: new URL(request.url).host,
  token: { symbol: TEMPO.usdc.symbol, address: TEMPO.usdc.address, decimals: TEMPO.usdc.decimals },
  amount: quote.amountUsd,
  amountUsd: quote.amountUsd,
  recipient: request.payee.recipient,
  request: { method: request.method, url: request.url.split('?')[0] ?? request.url },
  expiresAt: quote.expiresAt,
})

const challengeRefusal = (error: unknown) =>
  error instanceof TempoError
    ? failure(error.code, error.message, 400, 'Fetch a fresh challenge from the service and pay that.')
    : failure('bad_challenge', 'The challenge could not be read.', 400)

/**
 * Reads a new operation's challenge and binds it to the operation before anything is reserved: it must pay the payee's
 * known recipient, and one challenge pays one operation, so the same challenge under another operation_id is refused
 * (returning its credential there would let two operations claim one payment).
 */
const claimFresh = (operationId: string, request: PayRequest) =>
  Effect.gen(function* () {
    const now = yield* DateTime.nowAsDate
    const quote = yield* Effect.try({
      try: () => readChallenge(request.challenge, now),
      catch: challengeRefusal,
    })
    if (quote.terms.recipient.toLowerCase() !== request.payee.recipient.toLowerCase())
      return yield* failure(
        'unexpected_recipient',
        `The challenge pays ${quote.terms.recipient}, not the recipient ${request.payee.title} is known by. Nothing was signed.`,
        403,
      )
    const claim = yield* (yield* Ledger).use((api) => api.claimChallenge(operationId, quote.challengeId))
    if (!claim.ok)
      return yield* claim.code === 'challenge_reused'
        ? failure(
            'challenge_reused',
            `This challenge already belongs to operation ${claim.operationId}; one challenge pays one operation.`,
            409,
            'Retry with that operation_id, or fetch a new challenge for a new operation.',
          )
        : failure('operation_id_reused', 'This operation_id was already used with another challenge.', 409)
    return { challengeId: quote.challengeId, terms: termsOf(request, quote) }
  })

/**
 * `pay_challenge` paying: an allow-listed payee's challenge, frozen and reserved like any spend (no first-use approval
 * for a payee on the list; the wallet limits apply, and a spend over them waits for the owner), signed once. A retry
 * with the same operation_id and arguments replays the operation and never signs again.
 */
export const payChallengePlan = (input: PayChallengeInput, client: string) =>
  Effect.gen(function* () {
    const request = yield* payRequestOf(input)
    const ledger = yield* Ledger
    const argsHash = yield* Effect.promise(() => argsHashOf(TOOLS.payChallenge, input))
    const seen = yield* ledger.use((api) => api.lookup(input.operation_id, argsHash))
    // A known operation (a replay, or one the owner approved) keeps the challenge it claimed and its frozen terms.
    const frozen =
      seen.kind === 'none'
        ? yield* claimFresh(input.operation_id, request)
        : {
            challengeId: (yield* ledger.use((api) => api.challengeCredential(input.operation_id)))?.challengeId ?? '',
            terms: seen.operation.terms,
          }
    const plan: SpendPlan = {
      operationId: input.operation_id,
      argsHash,
      maxUsd: request.maxUsd,
      client,
      exempt: [],
      quote: () => Promise.resolve(frozen.terms),
      pay: (port, operation) => port.payChallenge(operation, request.challenge, frozen.challengeId),
    }
    return plan
  })

/** `pay_challenge` paying: the spend, then the credential the operation keeps (none until it is signed). */
export const payChallenge = (input: PayChallengeInput, client: string) =>
  Effect.gen(function* () {
    const outcome = yield* runSpend(yield* payChallengePlan(input, client))
    const held = yield* (yield* Ledger).use((api) => api.challengeCredential(input.operation_id))
    return { outcome, credential: held?.credential }
  })

const REPORTED = {
  status: 'reported',
  detail: 'The caller reported the Payment-Receipt; the wallet checked it on chain but did not see the response.',
}

/**
 * `pay_challenge` reporting: the service's Payment-Receipt for an operation whose credential was handed over. The
 * receipt settles it only when Tempo shows the agent's payment under that challenge; a transaction Tempo does not show
 * yet leaves it unknown, and a receipt of anything else is refused. A settled operation answers `paid` again.
 */
export const reportChallengeReceipt = (operationId: string, receipt: string) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const operation = yield* readOperation(operationId)
    const held = yield* ledger.use((api) => api.challengeCredential(operationId))
    if (held?.credential === undefined)
      return yield* failure('not_a_challenge', `Operation ${operationId} has no signed challenge to settle.`, 409)
    if (operation.status === 'confirmed' || operation.status === 'delivered')
      return { operation, found: 'paid' as const }
    if (operation.status !== 'uncertain')
      return yield* failure(
        'not_uncertain',
        `Operation ${operationId} is ${operation.status}; it takes no receipt.`,
        409,
      )
    const finding = yield* (yield* Rails).use((port) => port.confirmChallenge(operation, held.challengeId, receipt))
    if (finding.kind === 'mismatch')
      return yield* failure(
        'receipt_mismatch',
        `${finding.reason} The operation stays unknown.`,
        409,
        "Report the Payment-Receipt of this operation's own request.",
      )
    if (finding.kind === 'unknown') return { operation, found: 'unknown' as const, note: finding.reason }
    const settled = yield* ledger.use((api) =>
      api.settle(operationId, { payment: finding.payment, delivery: REPORTED, delivered: true }),
    )
    return { operation: settled.ok ? settled.operation : operation, found: 'paid' as const }
  })
