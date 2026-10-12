// Paying goblin's paid inference (ADR 0047): one MPP challenge a model call was answered with, paid by the owner's
// Goblin Wallet through its payment tool, as the `inference` caller. Nothing else reaches that tool this way, and the
// model never sees it.
import * as Effect from 'effect/Effect'
import { InvalidInput } from '../http/errors.ts'
import { paymentFailed } from '../pi/model.ts'
import { reportAndRecover } from '../observability/report.ts'
import { isRecord } from '../runtime/digest.ts'
import { profileOf } from './first-class.ts'
import { McpConnections, McpServers } from './service.ts'

/** goblin pays at most this much for one model call, whatever the challenge asks (the wallet's limits apply too). */
export const MAX_CALL_USD = '0.05'

/** The challenge's id (`Payment id="…"`), the operation the wallet keys the payment by. */
export const challengeId = (challenge: string): string | undefined => /\bid="([^"]{1,128})"/u.exec(challenge)?.[1]

/** The credential the wallet answers with, without the `Payment ` scheme, so the caller sets the header itself. */
const credentialOf = (structured: unknown): string | undefined => {
  const value = isRecord(structured) ? structured['credential'] : undefined
  return typeof value === 'string' && value !== '' ? value.replace(/^Payment\s+/iu, '') : undefined
}

/** The status of the operation a wallet answer names, such as `awaiting_approval` for a spend over a limit. */
const operationStatus = (structured: unknown): unknown => {
  const operation = isRecord(structured) ? structured['operation'] : undefined
  return isRecord(operation) ? operation['status'] : undefined
}

/** Where a payment was made: the wallet connection and tool, and the operation the wallet keeps it under. */
export type InferencePayment = {
  readonly connectionId: string
  readonly tool: string
  readonly operationId: string
}

/**
 * Why the wallet did not pay, in its own terms: its refusal code (a bounded token) and its one-line message, which
 * only the owner reads (the model error a refused payment ends the call with), never telemetry.
 */
export type PaymentRefusal = { readonly code: string; readonly message?: string }

/** A challenge paid (the credential and the payment it settles), or refused by the wallet. */
export type ChallengeOutcome =
  | { readonly paid: true; readonly credential: string; readonly payment: InferencePayment }
  | { readonly paid: false; readonly refusal: PaymentRefusal }

const CODE = /^[a-z_]{1,40}$/u
const MAX_WORDS = 200

/** A message on one line, at most 200 characters. */
const oneLine = (text: string): string => {
  const line = text.replaceAll(/\s+/gu, ' ').trim()
  return line.length <= MAX_WORDS ? line : `${line.slice(0, MAX_WORDS - 1)}…`
}

/**
 * The wallet's refusal from its tool's `structuredContent.error` (`{ code, message, recovery }`): a code that is not a
 * bounded token is none, and so is a message that is not text.
 */
export const refusalOf = (structured: unknown): PaymentRefusal => {
  const error = isRecord(structured) ? structured['error'] : undefined
  const code = isRecord(error) ? error['code'] : undefined
  const message = isRecord(error) ? error['message'] : undefined
  const words = typeof message === 'string' && message.trim() !== '' ? oneLine(message) : undefined
  return {
    code: typeof code === 'string' && CODE.test(code) ? code : 'refused',
    ...(words === undefined ? {} : { message: words }),
  }
}

/**
 * Pays `challenge` for the request to `url` from the owner's connected Goblin Wallet, and answers the credential with
 * the payment it settles, or the wallet's refusal. Fails when no wallet with a payment tool is signed in, or when goblin
 * may not reach its payment tool.
 */
export const payInferenceChallenge = (request: {
  readonly url: string
  readonly method: string
  readonly challenge: string
}) =>
  Effect.gen(function* () {
    const servers = yield* McpServers.use((owner) => owner.list())
    const wallet = servers.find(
      (server) => server.status === 'connected' && profileOf(server.endpoint)?.payment !== undefined,
    )
    const tool = wallet === undefined ? undefined : profileOf(wallet.endpoint)?.payment?.tool
    const id = challengeId(request.challenge)
    if (wallet === undefined || tool === undefined) return yield* new InvalidInput({ reason: 'no_paying_wallet' })
    if (id === undefined) return yield* new InvalidInput({ reason: 'payment_challenge_unreadable' })
    const payment: InferencePayment = { connectionId: wallet.connectionId, tool, operationId: `inference:${id}` }
    const result = yield* McpConnections.use((connections) =>
      connections.callTool(
        payment.connectionId,
        tool,
        { ...request, max_usd: MAX_CALL_USD, operation_id: payment.operationId },
        { caller: 'inference' },
      ),
    )
    if (operationStatus(result.structuredContent) === 'awaiting_approval')
      return yield* new InvalidInput({ reason: 'payment_over_limit' })
    if (result.isError === true)
      return { paid: false, refusal: refusalOf(result.structuredContent) } satisfies ChallengeOutcome
    const credential = credentialOf(result.structuredContent)
    if (credential === undefined) return { paid: false, refusal: { code: 'no_credential' } } satisfies ChallengeOutcome
    return { paid: true, credential, payment } satisfies ChallengeOutcome
  })

/**
 * Reports a paid answer's `Payment-Receipt` to the wallet that paid it, which checks it on chain and marks the payment
 * made; until then it holds the payment as unknown. A failure is reported here and never fails the call.
 */
export const settleInferencePayment = (payment: InferencePayment, receipt: string) =>
  Effect.gen(function* () {
    const result = yield* McpConnections.use((connections) =>
      connections.callTool(
        payment.connectionId,
        payment.tool,
        { operation_id: payment.operationId, receipt },
        { caller: 'inference' },
      ),
    )
    if (result.isError === true) return yield* new InvalidInput({ reason: 'payment_unsettled' })
  }).pipe(reportAndRecover('inference.settle', undefined))

/** goblin's own reasons a payment was not made, as refusal codes (`telemetry/safety.ts` keeps the same set). */
const OWN: Readonly<Record<string, string>> = {
  no_paying_wallet: 'no_paying_wallet',
  payment_challenge_unreadable: 'challenge_unreadable',
  payment_over_limit: 'over_limit',
  GrantDenied: 'grant_denied',
  Forbidden: 'ask_first',
  NeedsAuthorization: 'wallet_signed_out',
  UpstreamMcp: 'wallet_unreachable',
}

/** What went wrong, in words the owner can act on, by refusal code; `message` is the wallet's own line. */
const WHY: Readonly<Record<string, (message: string | undefined) => string | undefined>> = {
  insufficient_funds: (message) =>
    message === undefined
      ? 'your Goblin Wallet needs USDC.e on Tempo'
      : `your Goblin Wallet needs USDC.e on Tempo: ${message}`,
  insufficient_scope: () => 'sign in to it again on Connections and allow it to spend',
  above_max_usd: () => "the call costs more than goblin's $0.05 per-call cap",
  no_paying_wallet: () => 'connect your Goblin Wallet on Connections first',
  challenge_unreadable: () => "the provider's payment request could not be read",
  over_limit: () => 'the call is over a limit you set in the wallet',
  grant_denied: () => "allow its payment tool (Allow recommended on the wallet's card)",
  ask_first: () => 'its payment tool asks you first; set it to run when needed',
  wallet_signed_out: () => 'sign in to your Goblin Wallet again on Connections',
  wallet_unreachable: () => 'the wallet did not answer; try again in a moment',
}

/** A refusal the wallet answered, or goblin's own reason (an `AppError`, by its reason or its tag) as one. */
const refusalFrom = (failure: unknown): PaymentRefusal | undefined => {
  if (!isRecord(failure)) return undefined
  const { code, message, reason, _tag: tag } = failure
  if (typeof code === 'string') return { code, ...(typeof message === 'string' ? { message } : {}) }
  const own = (typeof reason === 'string' ? OWN[reason] : undefined) ?? (typeof tag === 'string' ? OWN[tag] : undefined)
  return own === undefined ? undefined : { code: own }
}

/**
 * The model error a refused payment ends the call with, for the owner (`paymentFailed`): its refusal code, and why in
 * words they can act on, or the wallet's own line.
 */
export const paymentFailureText = (failure: unknown): string => {
  const refusal = refusalFrom(failure)
  if (refusal === undefined) return paymentFailed(undefined, 'the wallet did not pay')
  return paymentFailed(
    refusal.code,
    WHY[refusal.code]?.(refusal.message) ?? refusal.message ?? 'the wallet did not pay',
  )
}
