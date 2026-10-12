// Paying goblin's paid inference (ADR 0046): one MPP challenge a model call was answered with, paid by the owner's
// Goblin Wallet through its payment tool, as the `inference` caller. Nothing else reaches that tool this way, and the
// model never sees it.
import * as Effect from 'effect/Effect'
import { InvalidInput } from '../http/errors.ts'
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

/**
 * Pays `challenge` for the request to `url` from the owner's connected Goblin Wallet: refused when no wallet with a
 * payment tool is signed in, or when the wallet refuses.
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
    const result = yield* McpConnections.use((connections) =>
      connections.callTool(
        wallet.connectionId,
        tool,
        { ...request, max_usd: MAX_CALL_USD, operation_id: `inference:${id}` },
        { caller: 'inference' },
      ),
    )
    const credential = result.isError === true ? undefined : credentialOf(result.structuredContent)
    if (credential === undefined) return yield* new InvalidInput({ reason: 'payment_refused' })
    return credential
  })

/** What went wrong, in words the owner can act on, for the model error a refused payment ends the call with. */
const WHY: Readonly<Record<string, string>> = {
  no_paying_wallet: 'connect your Goblin Wallet on Connections first',
  payment_challenge_unreadable: "the provider's payment request could not be read",
  payment_refused: 'it refused the payment (its limits or its funds)',
  GrantDenied: "allow its payment tool (Allow recommended on the wallet's card)",
  Forbidden: 'its payment tool asks you first; set it to run when needed',
}

export const paymentFailureText = (error: unknown): string => {
  const reason = isRecord(error) ? (error['reason'] ?? error['_tag']) : undefined
  const why = typeof reason === 'string' ? WHY[reason] : undefined
  return `Payment from your Goblin Wallet failed: ${why ?? 'the wallet did not pay'}.`
}
